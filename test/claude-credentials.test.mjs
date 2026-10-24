import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadClaudeCredentials, configureClaudeCredentials, claimClaudeCredential,
  markClaudeUnavailable, getClaudeCredentialStatus, resetClaudeCredentials,
} from '../src/claude-credentials.mjs';

const moduleURL = new URL('../src/claude-credentials.mjs', import.meta.url).href;
const cli = fileURLToPath(new URL('../scripts/claude-keys.mjs', import.meta.url));
const sample = () => ({ keys: [1, 2, 3].map(index => ({ id: `api-${index}`, apiKey: `fixture-secret-value-${index}` })) });

async function fixture(t, value = sample()) {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-credentials-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, CODJIFLO_ANTHROPIC_KEYS_FILE: path.join(home, 'config/keys.json'), CODJIFLO_CLAUDE_STATE_FILE: path.join(home, 'state/routing.json') };
  if (value) await configureClaudeCredentials(env, value);
  return { home, env, config: await loadClaudeCredentials(env) };
}

function subprocess(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const claimCode = `import {loadClaudeCredentials,claimClaudeCredential} from ${JSON.stringify(moduleURL)}; const key=await claimClaudeCredential(await loadClaudeCredentials()); console.log(key?.id ?? 'none');`;

test('missing config is OAuth-only; private directories and files are created atomically', async t => {
  const f = await fixture(t, null);
  assert.equal(f.config.mode, 'oauth-only');
  await configureClaudeCredentials(f.env, sample());
  const config = await loadClaudeCredentials(f.env);
  assert.equal(config.mode, 'api-pool');
  await claimClaudeCredential(config);
  for (const file of [config.keysFile, config.stateFile]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const directory of [path.dirname(config.keysFile), path.dirname(config.stateFile)]) assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const persisted = await readFile(config.stateFile, 'utf8');
  for (const key of sample().keys) assert.equal(persisted.includes(key.apiKey), false);
  assert.equal(persisted.includes('apiKey'), false);
});

test('four distinct processes claim A, B, C, A using one shared cursor', async t => {
  const f = await fixture(t);
  const actual = [];
  for (let index = 0; index < 4; index++) {
    const result = await subprocess(['--input-type=module', '-e', claimCode], f.env);
    assert.equal(result.code, 0, result.stderr);
    actual.push(result.stdout.trim());
  }
  assert.deepEqual(actual, ['api-1', 'api-2', 'api-3', 'api-1']);
});

test('concurrent processes lose neither cursor advances nor unavailability updates', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 13 }, () => subprocess(['--input-type=module', '-e', claimCode], f.env)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const counts = results.map(result => result.stdout.trim());
  assert.equal(counts.filter(id => id === 'api-1').length, 5);
  assert.equal(counts.filter(id => id === 'api-2').length, 4);
  assert.equal(counts.filter(id => id === 'api-3').length, 4);
  assert.equal((await getClaudeCredentialStatus(f.config)).cursor, 1);
  const updates = await Promise.all([0, 1, 2].map(index => subprocess(['--input-type=module', '-e', `import {loadClaudeCredentials,markClaudeUnavailable} from ${JSON.stringify(moduleURL)}; const c=await loadClaudeCredentials(); await markClaudeUnavailable(c,c.credentials[${index}],{status:'exhausted',retryAt:null,reason:'credit-balance'});`], f.env)));
  for (const result of updates) assert.equal(result.code, 0, result.stderr);
  assert.equal(await claimClaudeCredential(f.config), null);
});

test('cooldown expires at reset boundary, exclusions skip attempts, exhaustion needs reset', async t => {
  const { config } = await fixture(t);
  const first = await claimClaudeCredential(config, [], 1000);
  await markClaudeUnavailable(config, first, { status: 'cooldown', retryAt: 2000, reason: 'rate-limit' }, 1000);
  assert.equal(await claimClaudeCredential(config, ['api-2', 'api-3'], 1999), null);
  assert.equal((await claimClaudeCredential(config, ['api-2', 'api-3'], 2000)).id, 'api-1');
  await markClaudeUnavailable(config, first, { status: 'exhausted', retryAt: null, reason: 'spend-limit' }, 2000);
  assert.equal(await claimClaudeCredential(config, ['api-2', 'api-3'], 999999), null);
  await resetClaudeCredentials(config, ['api-1']);
  assert.equal((await claimClaudeCredential(config, ['api-2', 'api-3'], 999999)).id, 'api-1');
});

test('shared quota pool blocks together and stronger concurrent blocks are preserved', async t => {
  const input = sample();
  input.keys[0].quotaGroup = input.keys[1].quotaGroup = 'shared';
  const { config } = await fixture(t, input);
  await markClaudeUnavailable(config, config.credentials[0], { status: 'exhausted', retryAt: null, reason: 'spend-limit' }, 1000);
  await markClaudeUnavailable(config, config.credentials[1], { status: 'cooldown', retryAt: 2000, reason: 'rate-limit' }, 1000);
  const status = await getClaudeCredentialStatus(config, 3000);
  assert.deepEqual(status.keys.map(key => key.status), ['exhausted', 'exhausted', 'ready']);
  assert.equal((await claimClaudeCredential(config, [], 3000)).id, 'api-3');
});

test('rotating a key clears its state and old in-flight reports cannot disable new credentials', async t => {
  const f = await fixture(t);
  const old = f.config.credentials[0];
  await markClaudeUnavailable(f.config, old, { status: 'exhausted', retryAt: null, reason: 'spend-limit' });
  const input = sample();
  input.keys[0].apiKey = 'rotated-fixture-secret';
  await configureClaudeCredentials(f.env, input);
  // Deliberately use the stale config object for both methods.
  await markClaudeUnavailable(f.config, old, { status: 'exhausted', retryAt: null, reason: 'spend-limit' });
  const selected = await claimClaudeCredential(f.config);
  assert.equal(selected.apiKey, input.keys[0].apiKey);
  assert.equal((await getClaudeCredentialStatus(f.config)).keys[0].status, 'ready');
});

test('invalid config, permissions, symlinks, and corrupt state fail closed without input excerpts', async t => {
  const f = await fixture(t);
  const invalid = [null, {}, { keys: [] }, { keys: sample().keys.slice(1) }, { keys: [...sample().keys, sample().keys[0]] }, { keys: [sample().keys[0], sample().keys[0], sample().keys[2]] }, { keys: sample().keys.map(key => ({ ...key, id: '../unsafe' })) }];
  for (const value of invalid) {
    await writeFile(f.config.keysFile, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(loadClaudeCredentials(f.env), /Claude credentials:/);
  }
  await writeFile(f.config.keysFile, '{fixture-secret-value-1');
  await assert.rejects(loadClaudeCredentials(f.env), error => !error.message.includes('fixture-secret'));
  await configureClaudeCredentials(f.env, sample());
  await chmod(f.config.keysFile, 0o644);
  await assert.rejects(loadClaudeCredentials(f.env), /0600/);
  await chmod(f.config.keysFile, 0o600);
  const link = path.join(f.home, 'link');
  await symlink(f.config.keysFile, link);
  await assert.rejects(loadClaudeCredentials({ ...f.env, CODJIFLO_ANTHROPIC_KEYS_FILE: link }), /cannot read/);
  await claimClaudeCredential(f.config);
  await chmod(f.config.stateFile, 0o644);
  await assert.rejects(claimClaudeCredential(f.config), /0600/);
  await chmod(f.config.stateFile, 0o600);
  for (const content of ['{fixture-secret-value-1', 'null', '{}', '{"version":1,"cursor":0,"keys":{"bad":{"status":"ready"}}}']) {
    await writeFile(f.config.stateFile, content);
    await assert.rejects(claimClaudeCredential(f.config), error => !error.message.includes('fixture-secret'));
    await resetClaudeCredentials(f.config);
    assert.equal((await claimClaudeCredential(f.config)).id, 'api-1');
  }
});

test('CLI secure stdin configure validates all keys before replacing; status/reset never reveal secrets', async t => {
  const f = await fixture(t, null);
  let result = await subprocess([cli, 'configure', '--stdin'], f.env, JSON.stringify(sample()));
  assert.equal(result.code, 0, result.stderr);
  const original = await readFile(f.config.keysFile, 'utf8');
  result = await subprocess([cli, 'configure', '--stdin'], f.env, JSON.stringify({ keys: sample().keys.slice(1) }));
  assert.equal(result.code, 1);
  assert.equal(await readFile(f.config.keysFile, 'utf8'), original);
  const config = await loadClaudeCredentials(f.env);
  await markClaudeUnavailable(config, config.credentials[0], { status: 'exhausted', retryAt: null, reason: config.credentials[0].apiKey });
  for (const args of [['status'], ['reset', 'api-1'], ['status'], ['reset']]) {
    result = await subprocess([cli, ...args], f.env);
    assert.equal(result.code, 0, result.stderr);
    for (const key of sample().keys) assert.equal(`${result.stdout}${result.stderr}`.includes(key.apiKey), false);
  }
});

test('dead lock owner fails closed rather than stealing state', async t => {
  const f = await fixture(t);
  await claimClaudeCredential(f.config);
  await writeFile(`${f.config.stateFile}.lock`, 'pid=2147483647\n', { mode: 0o600 });
  await assert.rejects(claimClaudeCredential(f.config), /owner is dead or unidentified/);
  assert.equal(await readFile(`${f.config.stateFile}.lock`, 'utf8'), 'pid=2147483647\n');
});

test('known exhaustion reset re-enables keys and invalid configure preserves prior file', async t => {
  const f = await fixture(t);
  const before = await readFile(f.config.keysFile, 'utf8');
  const duplicateSecret = sample();
  duplicateSecret.keys[1].apiKey = duplicateSecret.keys[0].apiKey;
  await assert.rejects(configureClaudeCredentials(f.env, duplicateSecret), /invalid key configuration/);
  assert.equal(await readFile(f.config.keysFile, 'utf8'), before);
  await markClaudeUnavailable(f.config, f.config.credentials[0], { status: 'exhausted', retryAt: 5000, reason: 'spend-limit' }, 1000);
  assert.equal(await claimClaudeCredential(f.config, ['api-2', 'api-3'], 4999), null);
  assert.equal((await claimClaudeCredential(f.config, ['api-2', 'api-3'], 5000)).id, 'api-1');
  const rotated = sample();
  rotated.keys[0].apiKey = 'newly-rotated-fixture-secret';
  await configureClaudeCredentials(f.env, rotated);
  await claimClaudeCredential(f.config);
  assert.equal(f.config.credentials[0].apiKey, rotated.keys[0].apiKey);
});

test('out-of-order cooldown reports cannot shorten a shared-pool reset', async t => {
  const input = sample();
  input.keys[0].quotaGroup = input.keys[1].quotaGroup = 'shared';
  const { config } = await fixture(t, input);
  await markClaudeUnavailable(config, config.credentials[0], { status: 'cooldown', retryAt: 9000, reason: 'rate-limit' }, 1000);
  await markClaudeUnavailable(config, config.credentials[1], { status: 'cooldown', retryAt: 3000, reason: 'rate-limit' }, 2000);
  const status = await getClaudeCredentialStatus(config, 4000);
  assert.deepEqual(status.keys.slice(0, 2).map(key => [key.status, key.retryAt]), [['cooldown', 9000], ['cooldown', 9000]]);
  assert.equal(await claimClaudeCredential(config, ['api-3'], 8999), null);
  assert.equal((await claimClaudeCredential(config, ['api-3'], 9000)).id, 'api-1');
});
