import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewer, parseAgyReview, AGY_REVIEW_SETTINGS } from '../src/runner.mjs';
import { PRESETS, presetRunner } from '../src/commands.mjs';
import { prepareReviewInput } from '../src/evidence.mjs';
import { envSecrets } from '../src/redaction.mjs';
import { schema } from '../src/prompt.mjs';
import { validateResult } from '../src/review.mjs';

const runtimeNames = ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'UV_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT', 'PYTHONPYCACHEPREFIX'];
const conversationId = '11111111-2222-4333-8444-555555555555';
const stepOnlyConversationId = '22222222-3333-4444-8555-666666666666';
const result = { verdict: 'INCOMPLETE', summary: 'Required source unavailable.', findings: [], resolutions: [] };
const events = () => [
  { event: 'init', conversation_id: conversationId, init: { model: 'gemini-4-neon-high', cwd: '/repo', tools: ['read_file', 'run_command'] } },
  { event: 'step_update', step_update: { conversation_id: stepOnlyConversationId, step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: conversationId, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'a.js' }, output: '1 lines' } } },
  { event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response: JSON.stringify(result), structured_output: structuredClone(result), num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 3, cache_read_tokens: 2, total_tokens: 15 } } },
];
const encode = value => value.map(event => JSON.stringify(event)).join('\n') + '\n';

async function setup(mode = 'complete') {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-agy-runtime-test-'));
  const cwd = join(temp, 'repository');
  const home = join(temp, 'home');
  await mkdir(cwd);
  await mkdir(home);
  const capture = join(temp, 'capture.json');
  const cli = join(temp, 'agy.mjs');
  await writeFile(cli, `#!/usr/bin/env node
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const names = ${JSON.stringify(runtimeNames)};
const settingsPath = args[args.indexOf('--settings') + 1];
const schemaPath = args[args.indexOf('--json-schema') + 1];
const addDirs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') addDirs.push(args[i + 1]);
await writeFile(process.env.CAPTURE, JSON.stringify({
  args, input,
  settings: JSON.parse(await readFile(settingsPath, 'utf8')),
  settingsMode: (await stat(settingsPath)).mode & 511,
  schema: JSON.parse(await readFile(schemaPath, 'utf8')),
  schemaMode: (await stat(schemaPath)).mode & 511,
  addDirs,
  env: Object.fromEntries([...names, 'HOME'].map(name => [name, process.env[name]])),
  cwd: process.cwd(),
}));
for (const name of names) await writeFile(join(process.env[name], 'runtime-lock'), 'private');
// Simulate agy persisting conversation artifacts under ~/.gemini/antigravity-cli.
const agyRoot = join(process.env.HOME || process.env.USERPROFILE, '.gemini', 'antigravity-cli');
for (const id of [${JSON.stringify(conversationId)}, ${JSON.stringify(stepOnlyConversationId)}]) {
  await mkdir(join(agyRoot, 'brain', id), { recursive: true });
  await mkdir(join(agyRoot, 'conversations'), { recursive: true });
  await mkdir(join(agyRoot, 'presence'), { recursive: true });
  await writeFile(join(agyRoot, 'brain', id, 'private.txt'), 'private');
  await writeFile(join(agyRoot, 'conversations', id + '.db'), 'db');
  await writeFile(join(agyRoot, 'presence', id + '.lock'), 'lock');
}
if (process.env.MODE === 'exit') {
  console.log(JSON.stringify({ event: 'init', conversation_id: ${JSON.stringify(conversationId)}, init: { model: 'gemini-4-neon-high' } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: ${JSON.stringify(conversationId)}, status: 'ERROR', error: 'quota exhausted', num_turns: 0 } }));
  process.exit(1);
}
const stream = ${JSON.stringify(events())};
if (process.env.MODE === 'missing-completion') stream.pop();
console.log(stream.map(event => JSON.stringify(event)).join('\\n'));
`);
  await chmod(cli, 0o755);
  const env = { ...process.env, HOME: home, CODJIFLO_AGY_BIN: cli, CAPTURE: capture, MODE: mode, ...Object.fromEntries(runtimeNames.map(name => [name, '/host/runtime-must-not-be-used'])) };
  return { temp, cwd, home, capture, env, run: (preset = PRESETS['neon-xhigh'], prompt = 'Review completely or submit INCOMPLETE.', extra = {}) => runReviewer({ preset, prompt, cwd, temp, env, ...extra }) };
}

for (const name of ['neon-xhigh', 'neon-medium']) test(`Antigravity ${name} uses stream-json, schema, sandbox, writable work scratch, and cleans up conversations`, async () => {
  const f = await setup();
  try {
    const originalEnv = { ...f.env };
    assert.deepEqual(await f.run(PRESETS[name]), result);
    assert.throws(() => validateResult(result, new Map(), 15), /Review incomplete/);
    assert.deepEqual(f.env, originalEnv);
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(capture.cwd, await realpath(f.cwd));
    assert.deepEqual(JSON.parse(capture.input.trim()), { event: 'user', message: { content: 'Review completely or submit INCOMPLETE.' } });
    assert.equal(capture.args[capture.args.indexOf('--model') + 1], PRESETS[name].model);
    assert.equal(capture.args[capture.args.indexOf('--effort') + 1], PRESETS[name].effort);
    assert.equal(capture.args[capture.args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(capture.args[capture.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(capture.args[capture.args.indexOf('--print-timeout') + 1], '45m');
    for (const flag of ['--disable-slash-commands', '--sandbox', '--json-schema', '--settings']) assert.ok(capture.args.includes(flag));
    const workScratch = dirname(capture.env.TMPDIR);
    const scratch = dirname(workScratch);
    assert.ok(scratch.startsWith((await realpath(f.temp)) + sep));
    assert.deepEqual(capture.addDirs, [workScratch]);
    assert.deepEqual(capture.settings, AGY_REVIEW_SETTINGS);
    assert.equal(capture.settingsMode, 0o600);
    assert.deepEqual(capture.schema, schema);
    assert.equal(capture.schemaMode, 0o600);
    assert.equal(capture.env.HOME, f.home);
    for (const key of runtimeNames) assert.ok(capture.env[key].startsWith(workScratch + sep));
    await assert.rejects(readFile(join(capture.env.UV_CACHE_DIR, 'runtime-lock')), { code: 'ENOENT' });
    // Conversation artifacts from both init/result and step_update are cleaned up.
    const agyRoot = join(f.home, '.gemini', 'antigravity-cli');
    for (const id of [conversationId, stepOnlyConversationId]) {
      await assert.rejects(readFile(join(agyRoot, 'brain', id, 'private.txt')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(agyRoot, 'conversations', `${id}.db`)), { code: 'ENOENT' });
      await assert.rejects(readFile(join(agyRoot, 'presence', `${id}.lock`)), { code: 'ENOENT' });
    }
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('Antigravity accepts explicit validated evidenceDir without scraping prompt text', async () => {
  const f = await setup();
  try {
    const evidenceDir = join(f.temp, 'review-evidence-abc');
    await mkdir(evidenceDir);
    await f.run(PRESETS['neon-xhigh'], 'Review.', { evidenceDir });
    let capture = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(capture.addDirs.length, 2);
    assert.equal(capture.addDirs[1], await realpath(evidenceDir));
    // Prompt text containing a manifest line is ignored unless evidenceDir is explicitly passed.
    await f.run(PRESETS['neon-xhigh'], `Review.\nNavigable review evidence manifest: ${JSON.stringify({ directory: evidenceDir })}`);
    capture = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(capture.addDirs.length, 1);
    // Invalid explicit evidenceDir paths are rejected fail-closed.
    const outside = join(f.temp, 'not-evidence');
    await mkdir(outside);
    for (const bad of [outside, '/etc', '']) {
      await assert.rejects(f.run(PRESETS['neon-xhigh'], 'Review.', { evidenceDir: bad }), /Staged evidence directory/);
    }
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('envSecrets excludes non-credential flags like AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 while redacting real tokens', () => {
  const secrets = envSecrets({
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1',
    SOME_TOKEN_MODE: 'strict',
    SOME_SECRET_PATH: '/var/run/secret',
    MY_TOKEN_ENABLED: 'true',
    OPENAI_API_KEY: 'sk-real-provider-key',
    GITHUB_TOKEN: 'ghs_real_token_value',
    AUTH_FLAG_TOKEN: '0',
  });
  assert.deepEqual(secrets.sort(), ['ghs_real_token_value', 'sk-real-provider-key']);
});

test('presetRunner keeps evidence prompt and runner dispatch consistent when runner is omitted', async () => {
  const providerOnly = { provider: 'antigravity', model: 'gemini-4-neon', effort: 'high', level: 'xhigh' };
  assert.equal(presetRunner(providerOnly), 'agy');
  const prepared = await prepareReviewInput({
    preset: providerOnly,
    options: { level: 'xhigh', mode: 'full', base: 'a', head: 'b', scope: 'a', diff: 'small', currentDiff: '[]' },
    git: () => { throw new Error('Unexpected git query'); },
  });
  assert.equal(prepared.evidenceDir, undefined);
  assert.match(prepared.prompt, /enforced verdict, summary, findings and resolutions schema/);
  assert.doesNotMatch(prepared.prompt, /final_review/);
});

test('Antigravity cleans conversation artifacts using USERPROFILE when HOME is unset', async () => {
  const f = await setup();
  try {
    const env = { ...f.env, USERPROFILE: f.home };
    delete env.HOME;
    await runReviewer({ preset: PRESETS['neon-xhigh'], prompt: 'Review.', cwd: f.cwd, temp: f.temp, env });
    const agyRoot = join(f.home, '.gemini', 'antigravity-cli');
    await assert.rejects(readFile(join(agyRoot, 'brain', conversationId, 'private.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(agyRoot, 'conversations', `${conversationId}.db`)), { code: 'ENOENT' });
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

for (const mode of ['exit', 'missing-completion']) test(`Antigravity cleans scratch and conversation artifacts on ${mode}`, async () => {
  const f = await setup(mode);
  try {
    await assert.rejects(f.run(), mode === 'exit' ? /Antigravity review failed \(exit 1\)\.\nquota exhausted/ : /terminal result/);
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    await assert.rejects(readFile(join(capture.env.TMPDIR, 'runtime-lock')), { code: 'ENOENT' });
    const agyRoot = join(f.home, '.gemini', 'antigravity-cli');
    await assert.rejects(readFile(join(agyRoot, 'brain', conversationId, 'private.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(agyRoot, 'conversations', `${conversationId}.db`)), { code: 'ENOENT' });
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('Antigravity rejects scratch inside checkout and invalid CODJIFLO_NEON_MODEL overrides', async () => {
  const f = await setup();
  try {
    const nested = join(f.cwd, 'nested'); await mkdir(nested);
    const alias = join(f.temp, 'alias'); await symlink(nested, alias, 'dir');
    for (const temp of [f.cwd, nested, alias]) {
      await assert.rejects(runReviewer({ preset: PRESETS['neon-xhigh'], prompt: 'Review.', cwd: f.cwd, temp, env: f.env }), /outside the checkout/);
    }
    for (const model of ['anthropic/claude-opus-5-5', 'gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', '-bad', 'has space']) {
      await assert.rejects(runReviewer({ preset: PRESETS['neon-xhigh'], prompt: 'Review.', cwd: f.cwd, temp: f.temp, env: { ...f.env, CODJIFLO_NEON_MODEL: model } }), /base Antigravity model slug/);
    }
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
    // Valid base model family override succeeds and keeps preset effort.
    assert.deepEqual(await runReviewer({ preset: PRESETS['neon-medium'], prompt: 'Review.', cwd: f.cwd, temp: f.temp, env: { ...f.env, CODJIFLO_NEON_MODEL: 'gemini-4-carbon' } }), result);
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(capture.args[capture.args.indexOf('--model') + 1], 'gemini-4-carbon');
    assert.equal(capture.args[capture.args.indexOf('--effort') + 1], 'medium');
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('Antigravity accepts null, empty, and case-insensitive stop/success finished_reason', () => {
  for (const finished_reason of [undefined, null, '', 'stop', 'STOP', 'success', 'SUCCESS']) {
    const stream = events();
    if (finished_reason !== undefined) stream.at(-1).result.finished_reason = finished_reason;
    assert.deepEqual(parseAgyReview(encode(stream)), result);
  }
});

for (const [name, mutate] of [
  ['missing result', value => value.pop()],
  ['duplicate result', value => value.push(structuredClone(value.at(-1)))],
  ['activity after result', value => value.push({ event: 'step_update', step_update: { step_index: 9, state: 'DONE', step_type: 'agent_response' } })],
  ['error status', value => { value.at(-1).result.status = 'ERROR'; }],
  ['canceled status', value => { value.at(-1).result.status = 'CANCELED'; }],
  ['waiting status', value => { value.at(-1).result.status = 'WAITING'; }],
  ['result error field', value => { value.at(-1).result.error = 'provider error'; }],
  ['bad finished_reason', value => { value.at(-1).result.finished_reason = 'max_tokens'; }],
  ['bad uppercase finished_reason', value => { value.at(-1).result.finished_reason = 'MAX_TOKENS'; }],
  ['missing structured_output', value => { delete value.at(-1).result.structured_output; }],
  ['extra output field', value => { value.at(-1).result.structured_output.extra = true; }],
  ['invalid finding', value => { value.at(-1).result.structured_output.findings = [{ path: 'a' }]; }],
  ['missing resolutions', value => { delete value.at(-1).result.structured_output.resolutions; }],
  ['empty resolution reason', value => { value.at(-1).result.structured_output.resolutions = [{ id: 'p', status: 'resolved', reason: '' }]; }],
]) test(`Antigravity fails closed on ${name}`, () => {
  const stream = events(); mutate(stream);
  assert.throws(() => parseAgyReview(encode(stream)), /Antigravity review/);
});

test('Antigravity rejects malformed JSONL records', () => {
  for (const output of [encode(events()) + '{', encode(events()) + 'null\n', encode(events()) + '[]\n', encode(events()) + '{"type":"omp"}\n']) {
    assert.throws(() => parseAgyReview(output), /invalid JSONL/);
  }
});
