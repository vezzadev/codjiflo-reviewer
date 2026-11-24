import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from './prompt.mjs';
import { secretRedactor } from './redaction.mjs';
import { ompLogFormatter } from './omp-log.mjs';
import { agyLogFormatter } from './agy-log.mjs';
import { MAX_INLINE_INPUT } from './input-budget.mjs';

const CONVERSATION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const AGY_MODEL_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const AGY_EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|max)$/i;

// Only protocol error fields are diagnostics; never publish raw model/tool
// output or stderr. Intermediate provider failures may recover inside OMP.
function ompDiagnostics(stdout, redact) {
  const messages = [];
  for (const line of (stdout ?? '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const assistant = event?.type === 'agent_end' && Array.isArray(event.messages)
      ? event.messages.filter(message => message?.role === 'assistant').at(-1) : undefined;
    const message = assistant?.errorMessage;
    if (typeof message === 'string') messages.push(redact(message));
  }
  return messages.join('\n').slice(-1200);
}

// Only terminal protocol error fields are diagnostics; never publish raw model
// responses, tool output or stderr.
function agyDiagnostics(stdout, redact) {
  const messages = [];
  for (const line of (stdout ?? '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.event === 'result' ? event.result?.error : undefined;
    if (typeof message === 'string' && message.trim()) messages.push(redact(message));
  }
  return messages.join('\n').slice(-1200);
}

// Validate against the same closed JSON schema used by the review contract,
// independently of OMP's extension-side validation.
function matchesSchema(value, definition) {
  if (definition.enum && !definition.enum.includes(value)) return false;
  if (definition.type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && definition.required.every(key => Object.hasOwn(value, key))
      && Object.keys(value).every(key => Object.hasOwn(definition.properties, key) && matchesSchema(value[key], definition.properties[key]));
  }
  if (definition.type === 'array') return Array.isArray(value) && value.every(item => matchesSchema(item, definition.items));
  if (definition.type === 'integer') return Number.isInteger(value) && value >= definition.minimum;
  if (definition.type === 'string') {
    if (typeof value !== 'string') return false;
    if (definition.minLength === undefined) return true;
    // JSON Schema counts Unicode code points, not UTF-16 code units.
    let length = 0;
    for (const character of value) length++;
    return length >= definition.minLength;
  }
  return typeof value === definition.type;
}

export function parseOmpReview(stdout) {
  let events;
  try { events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error('OMP review failed: invalid JSONL protocol output. See process logs for details.'); }
  if (events.some(event => !event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string')) {
    throw new Error('OMP review failed: invalid JSONL protocol output.');
  }
  const terminalIndex = events.findLastIndex(event => event.type === 'agent_end');
  const terminal = events[terminalIndex];
  const assistant = Array.isArray(terminal?.messages) ? terminal.messages.filter(message => message?.role === 'assistant').at(-1) : undefined;
  if (!terminal || terminal.isTerminal === false || assistant?.stopReason !== 'stop' || assistant.errorMessage
      || events.slice(terminalIndex + 1).some(event => ['agent_start', 'message_start', 'message_end', 'tool_execution_start', 'tool_execution_end'].includes(event.type))) {
    throw new Error('OMP review did not complete successfully (missing terminal agent_end or unsuccessful last assistant).');
  }
  const calls = type => events.filter(event => event.type === type && event.toolName === 'final_review');
  const allStarts = calls('tool_execution_start'), allEnds = calls('tool_execution_end');
  // A call the tool rejected (unparseable or invalid arguments) captured
  // nothing, so the model may correct it. Only a rejection the model saw is
  // a retry: an assistant message must end between it and the accepted call.
  // A rejected call beside or after the accepted one is a second review.
  const acceptedEnd = allEnds.find(event => event.isError === false);
  const acceptedStart = events.indexOf(allStarts.find(event => event.toolCallId === acceptedEnd?.toolCallId));
  const seen = events.slice(0, Math.max(acceptedStart, 0)).findLastIndex(event => event.type === 'message_end' && event.message?.role === 'assistant');
  // Events are classified by position, not by call ID alone: an ID reused
  // after the accepted call must not hide a later attempt.
  const early = event => events.indexOf(event) < seen;
  const retriedIds = new Set(allEnds.filter(event => event.isError === true && typeof event.toolCallId === 'string' && early(event)).map(event => event.toolCallId));
  const retried = event => early(event) && retriedIds.has(event.toolCallId);
  const starts = allStarts.filter(event => !retried(event)), ends = allEnds.filter(event => !retried(event));
  if (starts.length !== 1 || ends.length !== 1 || typeof starts[0].toolCallId !== 'string' || !starts[0].toolCallId
      || ends[0].toolCallId !== starts[0].toolCallId || ends[0].isError !== false
      || events.indexOf(ends[0]) <= events.indexOf(starts[0]) || events.indexOf(ends[0]) >= terminalIndex
      || !matchesSchema(starts[0].args, schema)) {
    // Counts only: with withheld logs this message is the sole diagnostic, and call arguments are review content.
    const failed = allEnds.filter(event => event.isError !== false).length;
    const detail = `${allStarts.length} started, ${allEnds.length} completed, ${failed} rejected${starts.length === 1 && ends.length === 1 && ends[0].isError === false ? ', arguments or ordering invalid' : ''}`;
    throw new Error(`OMP review failed: missing, duplicate, failed or malformed final_review result (final_review calls: ${detail}).`);
  }
  return starts[0].args;
}

export function parseAgyReview(stdout) {
  let events;
  try { events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error('Antigravity review failed: invalid JSONL protocol output. See process logs for details.'); }
  if (events.some(event => !event || typeof event !== 'object' || Array.isArray(event) || typeof event.event !== 'string')) {
    throw new Error('Antigravity review failed: invalid JSONL protocol output.');
  }
  const results = events.filter(event => event.event === 'result');
  const terminal = results[0];
  const terminalIndex = terminal ? events.indexOf(terminal) : -1;
  const result = terminal?.result;
  const badFinish = result?.finished_reason !== undefined && !['stop', 'success'].includes(result.finished_reason);
  if (results.length !== 1 || !result || typeof result !== 'object' || Array.isArray(result)
      || result.status !== 'SUCCESS' || result.error || badFinish
      || events.slice(terminalIndex + 1).some(event => ['init', 'step_update', 'result'].includes(event.event))) {
    throw new Error('Antigravity review did not complete successfully (missing, duplicate, or unsuccessful terminal result).');
  }
  if (!matchesSchema(result.structured_output, schema)) {
    throw new Error('Antigravity review failed: missing or malformed structured_output result.');
  }
  return result.structured_output;
}

export const AGY_REVIEW_SETTINGS = {
  agentMode: 'auto',
  enableTerminalSandbox: true,
  allowNonWorkspaceAccess: false,
  disableSlashCommands: true,
  showTips: false,
  showFeedbackSurvey: false,
  notifications: false,
  permissions: {
    allow: ['read_file(*)', 'command(*)'],
    deny: ['write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'],
  },
};

// Disable capability discovery, not model providers or the shared auth store.
// These are exact OMP settings (docs/context-files.md and domain settings.ts).
export const OMP_REVIEW_CONFIG = {
  disabledProviders: ['native', 'claude', 'codex', 'gemini', 'opencode', 'github', 'agents', 'agents-md', 'claude-md', 'cursor', 'windsurf', 'cline', 'vscode', 'mcp-json', 'claude-plugins', 'omp-plugins', 'agent-plugins', 'ssh-json', 'builtin-defaults', 'omp-managed'],
  extensions: [],
  mcp: { enableProjectConfig: false, notifications: false },
  advisor: { enabled: false },
  memory: { backend: 'off' },
  autolearn: { enabled: false, autoContinue: false },
  prewalk: { enabled: false },
  plan: { enabled: false },
  todo: { enabled: false },
  tools: { xdev: false },
  providers: { cacheWarming: 'off' },
  read: { summarize: { enabled: false } },
  bash: { direnv: 'off', autoBackground: { enabled: false } },
  glob: { enabled: true },
  grep: { enabled: true },
  find: { enabled: 'on' },
};

export async function runProcess(command, args, { cwd, env = process.env, input, stream = false, streamOutput, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    // A separate process group lets a timeout stop CLI-spawned tools as well.
    const processGroup = process.platform !== 'win32';
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: processGroup, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(Object.assign(error, { termination: 'spawn' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (processGroup) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (stream) (streamOutput?.stdout ?? (text => process.stdout.write(text)))(data); });
    child.stderr.on('data', data => { stderr += data; if (stream) (streamOutput?.stderr ?? (text => process.stderr.write(text)))(data); });
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(error, { stdout, termination: 'spawn' })); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(Object.assign(error, { stdout, termination: 'spawn' })); });
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms: ${stderr.slice(-2000)}`), { stdout, termination: 'timeout', exitCode: code, signal }));
      else if (code !== 0) reject(Object.assign(new Error(`${command} failed (${signal ?? code}): ${stderr.slice(-2000)}`), { stdout, termination: signal ? 'signal' : 'exit', exitCode: code, signal }));
      else resolve(stdout);
    });
  });
}

async function stagedEvidenceDir(prompt, parent) {
  for (const line of prompt.split('\n')) {
    if (!line.startsWith('Navigable review evidence manifest: ')) continue;
    let directory;
    try { directory = JSON.parse(line.slice('Navigable review evidence manifest: '.length))?.directory; }
    catch { continue; }
    if (typeof directory !== 'string' || !directory) continue;
    try {
      const resolved = await realpath(directory);
      if (dirname(resolved) === parent && basename(resolved).startsWith('review-evidence-')) return resolved;
    } catch { continue; }
  }
  return undefined;
}

async function cleanupAgyConversations(stdout, home) {
  if (typeof home !== 'string' || !home || typeof stdout !== 'string' || !stdout) return;
  const ids = new Set();
  for (const line of stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const candidate of [event?.conversation_id, event?.result?.conversation_id]) {
      if (typeof candidate === 'string' && CONVERSATION_UUID.test(candidate)) ids.add(candidate);
    }
  }
  if (!ids.size) return;
  const root = join(home, '.gemini', 'antigravity-cli');
  await Promise.all([...ids].flatMap(id => [
    rm(join(root, 'brain', id), { recursive: true, force: true }).catch(() => {}),
    rm(join(root, 'conversations', `${id}.db`), { force: true }).catch(() => {}),
    rm(join(root, 'conversations', `${id}.db-wal`), { force: true }).catch(() => {}),
    rm(join(root, 'conversations', `${id}.db-shm`), { force: true }).catch(() => {}),
    rm(join(root, 'presence', `${id}.lock`), { force: true }).catch(() => {}),
  ]));
}

function runtimeScratchEnv(scratch) {
  return {
    TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
    XDG_CACHE_HOME: join(scratch, 'cache'), UV_CACHE_DIR: join(scratch, 'uv-cache'),
    UV_PROJECT_ENVIRONMENT: join(scratch, 'venv'), PYTHONPYCACHEPREFIX: join(scratch, 'pycache'),
  };
}

function failureStatus(error) {
  return error.termination === 'timeout' ? 'timed out'
    : error.termination === 'exit' ? `failed (exit ${error.exitCode})`
    : error.termination === 'signal' ? `failed (${error.signal})`
    : 'could not run';
}

async function runAgyReviewer({ preset, prompt, cwd, parent, env, logStream }) {
  const model = env.CODJIFLO_NEON_MODEL || preset.model;
  if (preset.provider !== 'antigravity' || typeof model !== 'string'
      || !AGY_MODEL_SLUG.test(model) || AGY_EFFORT_SUFFIX.test(model)) {
    throw new Error('Antigravity review model must be a base Antigravity model slug without provider prefix or effort suffix');
  }
  const scratch = await mkdtemp(join(parent, 'review-runtime-'));
  const runtimeEnv = runtimeScratchEnv(scratch);
  const secrets = Object.entries(env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(name)).map(([, value]) => value);
  if (logStream === 'withheld') console.log('Antigravity output withheld from logs: the reviewed repository is private.');
  const out = secretRedactor(secrets, text => { if (logStream === 'live') process.stdout.write(text); });
  const err = secretRedactor(secrets, text => { if (logStream === 'live') process.stderr.write(text); });
  const transcript = logStream === 'live' ? agyLogFormatter(text => out.write(text), secrets) : undefined;
  let stdout = '';
  try {
    await Promise.all([...new Set(Object.values(runtimeEnv))].map(directory => mkdir(directory, { mode: 0o700 })));
    const schemaPath = join(scratch, 'schema.json');
    const settingsPath = join(scratch, 'settings.json');
    await Promise.all([
      writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 }),
      writeFile(settingsPath, JSON.stringify(AGY_REVIEW_SETTINGS), { mode: 0o600 }),
    ]);
    const evidenceDir = await stagedEvidenceDir(prompt, parent);
    const input = `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
    // Do not override HOME or copy credentials: agy owns its signed-in Google
    // account session and token refresh. Ephemeral settings and schema stay in scratch.
    stdout = await runProcess(env.CODJIFLO_AGY_BIN || 'agy', [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', model, '--effort', preset.effort,
      '--json-schema', schemaPath, '--settings', settingsPath,
      '--disable-slash-commands', '--sandbox', '--print-timeout', '45m',
      ...(evidenceDir ? ['--add-dir', evidenceDir] : []),
    ], { cwd, env: { ...env, ...runtimeEnv }, input, stream: true,
      streamOutput: { stdout: chunk => transcript?.write(chunk), stderr: chunk => err.write(chunk) }, timeoutMs: 45 * 60 * 1000 });
  } catch (error) {
    stdout = error.stdout ?? stdout;
    const diagnostic = agyDiagnostics(stdout, out.redact);
    const logs = logStream === 'live' ? 'See process logs for details.' : 'Antigravity output was withheld from the logs; rerun the review locally for details.';
    throw new Error(`Antigravity review ${failureStatus(error)}.${diagnostic ? `\n${diagnostic}` : ` ${logs}`}`);
  } finally {
    transcript?.end();
    out.end();
    err.end();
    await cleanupAgyConversations(stdout, env.HOME);
    await rm(scratch, { recursive: true, force: true });
  }
  try { return parseAgyReview(stdout); }
  catch (error) {
    const diagnostic = agyDiagnostics(stdout, out.redact);
    throw new Error(`${error.message}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
}

export async function runReviewer({ preset, prompt, cwd, temp, env = process.env, logStream = 'live' }) {
  if (prompt.length > MAX_INLINE_INPUT) throw new Error('Review input exceeds inline budget; structured evidence preparation is required');
  const parent = await realpath(temp), checkout = await realpath(cwd);
  const fromCheckout = relative(checkout, parent);
  if (fromCheckout === '' || (fromCheckout !== '..' && !fromCheckout.startsWith('..' + sep) && !isAbsolute(fromCheckout))) {
    throw new Error('Reviewer runtime scratch must be outside the checkout');
  }
  if (preset.runner === 'agy' || preset.provider === 'antigravity') {
    return runAgyReviewer({ preset, prompt, cwd, parent, env, logStream });
  }
  const model = env.CODJIFLO_OPUS_MODEL || preset.model;
  if (preset.provider !== 'anthropic' || !model.startsWith(`${preset.provider}/`) || !model.slice(preset.provider.length + 1)) {
    throw new Error('OMP review model must be explicitly provider-qualified and match its preset provider');
  }
  const scratch = await mkdtemp(join(parent, 'review-runtime-'));
  const runtimeEnv = runtimeScratchEnv(scratch);
  const secrets = Object.entries(env).filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(name)).map(([, value]) => value);
  if (logStream === 'withheld') console.log('OMP output withheld from logs: the reviewed repository is private.');
  const out = secretRedactor(secrets, text => { if (logStream === 'live') process.stdout.write(text); });
  const err = secretRedactor(secrets, text => { if (logStream === 'live') process.stderr.write(text); });
  // Withheld output is not rendered at all. The formatter redacts each value
  // before clipping; the stream redactor still covers what it writes.
  const transcript = logStream === 'live' ? ompLogFormatter(text => out.write(text), secrets) : undefined;
  let stdout;
  try {
    await Promise.all([...new Set(Object.values(runtimeEnv))].map(directory => mkdir(directory, { mode: 0o700 })));
    const config = join(scratch, 'config.json');
    await writeFile(config, JSON.stringify(OMP_REVIEW_CONFIG), { mode: 0o600 });
    // Do not override HOME/OMP data directories or copy credentials: OMP owns
    // shared refresh persistence, usage-aware account selection and retries.
    stdout = await runProcess(env.CODJIFLO_OMP_BIN || 'omp', [
      '-p', '--mode', 'json', '--no-session', '--no-title', '--no-lsp', '--no-pty',
      '--no-extensions', '--no-skills', '--no-rules', '--tools', 'read,grep,glob,find,bash',
      '--model', model, '--thinking', preset.effort, '--max-time', '45m',
      '--config', config, '--extension', fileURLToPath(new URL('./omp-review-extension.mjs', import.meta.url)),
    ], { cwd, env: { ...env, ...runtimeEnv }, input: prompt, stream: true,
      streamOutput: { stdout: chunk => transcript?.write(chunk), stderr: chunk => err.write(chunk) }, timeoutMs: 45 * 60 * 1000 });
  } catch (error) {
    const diagnostic = ompDiagnostics(error.stdout, out.redact);
    const logs = logStream === 'live' ? 'See process logs for details.' : 'OMP output was withheld from the logs; rerun the review locally for details.';
    throw new Error(`OMP review ${failureStatus(error)}.${diagnostic ? `\n${diagnostic}` : ` ${logs}`}`);
  } finally {
    transcript?.end();
    out.end();
    err.end();
    await rm(scratch, { recursive: true, force: true });
  }
  try { return parseOmpReview(stdout); }
  catch (error) {
    const diagnostic = ompDiagnostics(stdout, out.redact);
    throw new Error(`${error.message}${diagnostic ? `\n${diagnostic}` : ''}`);
  }
}
