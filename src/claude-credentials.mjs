import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { acquireLock } from './file-lock.mjs';

const label = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const fingerprint = key => createHash('sha256').update(key).digest('hex');
const failure = message => new Error(`Claude credentials: ${message}`);

function locations(env) {
  const home = env.HOME || homedir();
  return {
    keysFile: path.resolve(env.CODJIFLO_ANTHROPIC_KEYS_FILE || path.join(home, '.config/codjiflo/anthropic-keys.json')),
    stateFile: path.resolve(env.CODJIFLO_CLAUDE_STATE_FILE || path.join(home, '.local/state/codjiflo/claude-routing.json')),
  };
}

function validateKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'keys') || !Array.isArray(value.keys) || value.keys.length !== 3) throw failure('configuration must contain exactly three keys');
  const ids = new Set();
  const secrets = new Set();
  const credentials = value.keys.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(k => !['id', 'apiKey', 'quotaGroup'].includes(k)) || typeof entry.id !== 'string' || !label.test(entry.id) || typeof entry.apiKey !== 'string' || entry.apiKey.length < 1 || /\s|[\x00-\x1f\x7f]/.test(entry.apiKey) || (entry.quotaGroup !== undefined && (typeof entry.quotaGroup !== 'string' || !label.test(entry.quotaGroup))) || ids.has(entry.id) || secrets.has(entry.apiKey)) throw failure('invalid key configuration');
    ids.add(entry.id);
    secrets.add(entry.apiKey);
    return { id: entry.id, apiKey: entry.apiKey, quotaGroup: entry.quotaGroup ?? entry.id, fingerprint: fingerprint(entry.apiKey) };
  });
  if (credentials.some(entry => credentials.some(key => entry.id === key.apiKey || entry.quotaGroup === key.apiKey))) throw failure('key labels must not contain credentials');
  return credentials;
}

async function readPrivate(file, kind) {
  let handle;
  try {
    // Refuse symlinks and check the opened inode, not a prior path stat.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw failure(`${kind} must be an owner-only regular file (0600)`);
    const text = await handle.readFile('utf8');
    try { return JSON.parse(text); } catch { throw failure(`invalid ${kind} JSON`); }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.message?.startsWith('Claude credentials:')) throw error;
    throw failure(`cannot read ${kind}`);
  } finally {
    await handle?.close();
  }
}

async function privateDirectory(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('storage parent must be a directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent !== directory) await privateDirectory(parent);
    try { await mkdir(directory, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw failure('new storage directory must be private (0700)');
  }
}

async function atomicWrite(file, value) {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function loadClaudeCredentials(env = process.env) {
  const files = locations(env);
  const value = await readPrivate(files.keysFile, 'configuration');
  return { ...files, mode: value === undefined ? 'oauth-only' : 'api-pool', credentials: value === undefined ? [] : validateKeys(value) };
}

export async function configureClaudeCredentials(env, value) {
  const files = locations(env ?? process.env);
  const credentials = validateKeys(value);
  await atomicWrite(files.keysFile, { keys: credentials.map(({ id, apiKey, quotaGroup }) => ({ id, apiKey, quotaGroup })) });
}

function validateState(state) {
  if (!state || typeof state !== 'object' || state.version !== 1 || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || state.cursor > 2 || !state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys) || Object.keys(state).some(k => !['version', 'cursor', 'keys'].includes(k))) throw failure('corrupt routing state; use reset to recover');
  for (const [id, entry] of Object.entries(state.keys)) {
    if (!label.test(id) || !entry || typeof entry !== 'object' || Object.keys(entry).some(k => !['fingerprint', 'quotaGroup', 'status', 'retryAt', 'reason'].includes(k)) || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || typeof entry.quotaGroup !== 'string' || !label.test(entry.quotaGroup) || !['ready', 'cooldown', 'exhausted'].includes(entry.status) || !(entry.retryAt === null || (Number.isSafeInteger(entry.retryAt) && entry.retryAt >= 0)) || !(entry.reason === null || (typeof entry.reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(entry.reason))) || (entry.status === 'ready' && (entry.retryAt !== null || entry.reason !== null)) || (entry.status === 'cooldown' && entry.retryAt === null)) throw failure('corrupt routing state; use reset to recover');
  }
  return state;
}

const freshEntry = credential => ({ fingerprint: credential.fingerprint, quotaGroup: credential.quotaGroup, status: 'ready', retryAt: null, reason: null });

async function withState(config, operation, { recover = false } = {}) {
  await privateDirectory(path.dirname(config.stateFile));
  const lock = `${config.stateFile}.lock`;
  const handle = await acquireLock(lock, { label: 'Claude routing', staleLabel: 'Claude routing', onWait: () => {} });
  try {
    await handle.writeFile(`pid=${process.pid}\n`);
    // Re-read credentials inside the critical section so old in-flight callers
    // cannot restore/disable credentials replaced by another process.
    const value = await readPrivate(config.keysFile, 'configuration');
    const credentials = value === undefined ? [] : validateKeys(value);
    config.credentials = credentials;
    config.mode = credentials.length ? 'api-pool' : 'oauth-only';
    let state;
    if (recover) state = { version: 1, cursor: 0, keys: {} };
    else {
      const stored = await readPrivate(config.stateFile, 'routing state');
      state = validateState(stored === undefined ? { version: 1, cursor: 0, keys: {} } : stored);
    }
    const current = {};
    for (const credential of credentials) {
      const previous = state.keys[credential.id];
      current[credential.id] = previous?.fingerprint === credential.fingerprint && previous?.quotaGroup === credential.quotaGroup ? previous : freshEntry(credential);
    }
    state.keys = current;
    const result = await operation(state, credentials);
    await atomicWrite(config.stateFile, state);
    return result;
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

export async function claimClaudeCredential(config, excludedIds = [], now = Date.now()) {
  return withState(config, (state, credentials) => {
    for (let offset = 0; offset < credentials.length; offset++) {
      const index = (state.cursor + offset) % credentials.length;
      const credential = credentials[index];
      const entry = state.keys[credential.id];
      if (entry.retryAt !== null && entry.retryAt <= now) Object.assign(entry, freshEntry(credential));
      if (excludedIds.includes(credential.id) || entry.status !== 'ready') continue;
      state.cursor = (index + 1) % credentials.length;
      return credential;
    }
    return null;
  });
}

export async function markClaudeUnavailable(config, credential, { status, retryAt, reason }, now = Date.now()) {
  if (!['cooldown', 'exhausted'].includes(status) || !(retryAt === null || (Number.isSafeInteger(retryAt) && retryAt >= 0)) || (status === 'cooldown' && (retryAt === null || retryAt <= now))) throw failure('invalid unavailability update');
  const safeReason = typeof reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(reason) && !config.credentials.some(key => reason.includes(key.apiKey)) ? reason : 'unavailable';
  await withState(config, (state, credentials) => {
    const current = credentials.find(key => key.id === credential.id && key.fingerprint === credential.fingerprint && key.quotaGroup === credential.quotaGroup);
    if (!current) return;
    for (const key of credentials) {
      if (key.quotaGroup !== current.quotaGroup) continue;
      const entry = state.keys[key.id];
      // Never shorten a concurrent block, especially indefinite exhaustion.
      if (entry.status !== 'ready' && (entry.retryAt === null || (retryAt !== null && entry.retryAt > retryAt))) continue;
      Object.assign(entry, { status, retryAt, reason: safeReason });
    }
  });
}

export async function getClaudeCredentialStatus(config, now = Date.now()) {
  return withState(config, (state, credentials) => ({
    mode: credentials.length ? 'api-pool' : 'oauth-only', cursor: state.cursor,
    keys: credentials.map(credential => {
      const entry = state.keys[credential.id];
      if (entry.retryAt !== null && entry.retryAt <= now) Object.assign(entry, freshEntry(credential));
      return { id: credential.id, quotaGroup: credential.quotaGroup, status: entry.status, retryAt: entry.retryAt, reason: entry.reason };
    }),
  }));
}

export async function resetClaudeCredentials(config, ids = []) {
  // Full reset deliberately recovers malformed state. Targeted reset fails closed.
  return withState(config, (state, credentials) => {
    if (ids.some(id => !credentials.some(key => key.id === id))) throw failure('unknown key id');
    for (const credential of credentials) if (!ids.length || ids.includes(credential.id)) state.keys[credential.id] = freshEntry(credential);
  }, { recover: ids.length === 0 });
}
