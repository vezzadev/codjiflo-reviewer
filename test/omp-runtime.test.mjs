import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewer, parseOmpReview, OMP_REVIEW_CONFIG } from '../src/runner.mjs';
import { PRESETS } from '../src/commands.mjs';
import { validateResult } from '../src/review.mjs';
import { prompt } from '../src/prompt.mjs';
import reviewExtension, { REVIEW_TOOLS } from '../src/omp-review-extension.mjs';
import { secretRedactor } from '../src/redaction.mjs';

const runtimeNames = ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'UV_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT', 'PYTHONPYCACHEPREFIX'];
const result = { verdict: 'INCOMPLETE', summary: 'Required source unavailable.', findings: [] };
const events = () => [
  { type: 'tool_execution_start', toolName: 'final_review', toolCallId: 'review-1', args: structuredClone(result) },
  { type: 'tool_execution_end', toolName: 'final_review', toolCallId: 'review-1', isError: false, result: { details: { accepted: true } } },
  { type: 'agent_end', isTerminal: true, messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] },
];
const encode = value => value.map(event => JSON.stringify(event)).join('\n') + '\n';

async function setup(mode = 'complete') {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-runtime-test-'));
  const cwd = join(temp, 'repository');
  await mkdir(cwd);
  const capture = join(temp, 'capture.json');
  const cli = join(temp, 'omp.mjs');
  await writeFile(cli, `#!/usr/bin/env node
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const names = ${JSON.stringify(runtimeNames)};
const configPath = args[args.indexOf('--config') + 1];
await writeFile(process.env.CAPTURE, JSON.stringify({ args, input, config: JSON.parse(await readFile(configPath, 'utf8')), configMode: (await stat(configPath)).mode & 511, env: Object.fromEntries([...names, 'HOME', 'PI_CODING_AGENT_DIR', 'OMP_AGENT_DIR'].map(name => [name, process.env[name]])), cwd: process.cwd() }));
for (const name of names) await writeFile(join(process.env[name], 'runtime-lock'), 'private');
if (process.env.MODE === 'exit') process.exit(7);
const events = ${JSON.stringify(events())};
if (process.env.MODE === 'missing-completion') events.pop();
console.log(events.map(event => JSON.stringify(event)).join('\\n'));
`);
  await chmod(cli, 0o755);
  const env = { ...process.env, CODJIFLO_OMP_BIN: cli, CAPTURE: capture, MODE: mode, ...Object.fromEntries(runtimeNames.map(name => [name, '/host/runtime-must-not-be-used'])) };
  return { temp, cwd, capture, env, run: (preset = PRESETS['sol-xhigh']) => runReviewer({ preset, prompt: 'Review completely or submit INCOMPLETE.', cwd, temp, env }) };
}

for (const name of Object.keys(PRESETS)) test(`OMP ${name} uses shared auth, explicit model, private scratch and cleanup`, async () => {
  const f = await setup();
  try {
    const originalEnv = { ...f.env };
    assert.deepEqual(await f.run(PRESETS[name]), result);
    assert.throws(() => validateResult(result, new Map(), 15), /Review incomplete/);
    assert.deepEqual(f.env, originalEnv);
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(capture.cwd, await realpath(f.cwd));
    assert.equal(capture.input, 'Review completely or submit INCOMPLETE.');
    assert.equal(capture.args[capture.args.indexOf('--model') + 1], PRESETS[name].model);
    assert.equal(capture.args[capture.args.indexOf('--thinking') + 1], PRESETS[name].effort);
    for (const flag of ['-p', '--no-session', '--no-title', '--no-lsp', '--no-pty', '--no-extensions', '--no-skills', '--no-rules', '--extension']) assert.ok(capture.args.includes(flag));
    assert.ok(!capture.args.includes('-'));
    assert.ok(!capture.args.includes('--output-last-message'));
    assert.deepEqual(capture.config, OMP_REVIEW_CONFIG);
    assert.equal(capture.configMode, 0o600);
    for (const key of ['HOME', 'PI_CODING_AGENT_DIR', 'OMP_AGENT_DIR']) assert.equal(capture.env[key], f.env[key]);
    const scratch = dirname(capture.env.TMPDIR);
    assert.ok(scratch.startsWith((await realpath(f.temp)) + sep));
    for (const key of runtimeNames) assert.ok(capture.env[key].startsWith(scratch + sep));
    await assert.rejects(readFile(join(capture.env.UV_CACHE_DIR, 'runtime-lock')), { code: 'ENOENT' });
    await f.run(PRESETS[name]);
    const next = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.notEqual(next.env.TMPDIR, capture.env.TMPDIR);
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

for (const mode of ['exit', 'missing-completion']) test(`OMP cleans scratch on ${mode}`, async () => {
  const f = await setup(mode);
  try {
    await assert.rejects(f.run(), mode === 'exit' ? /failed \(exit 7\)/ : /terminal agent_end/);
    const capture = JSON.parse(await readFile(f.capture, 'utf8'));
    await assert.rejects(readFile(join(capture.env.TMPDIR, 'runtime-lock')), { code: 'ENOENT' });
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('OMP rejects scratch inside checkout including symlink aliases and unqualified model overrides', async () => {
  const f = await setup();
  try {
    const nested = join(f.cwd, 'nested'); await mkdir(nested);
    const alias = join(f.temp, 'alias'); await symlink(nested, alias, 'dir');
    for (const temp of [f.cwd, nested, alias]) await assert.rejects(runReviewer({ preset: PRESETS['sol-xhigh'], prompt: 'Review.', cwd: f.cwd, temp, env: f.env }), /outside the checkout/);
    for (const model of ['gpt-6.1-sol', 'anthropic/claude-opus-5-5', 'openai-codex/']) await assert.rejects(runReviewer({ preset: PRESETS['sol-xhigh'], prompt: 'Review.', cwd: f.cwd, temp: f.temp, env: { ...f.env, CODJIFLO_SOL_MODEL: model } }), /provider-qualified/);
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('OMP accepts recovered provider attempts, not failed terminal output', () => {
  const stream = events();
  stream.unshift({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'retryable quota' } });
  assert.deepEqual(parseOmpReview(encode(stream)), result);
});

for (const [name, mutate] of [
  ['missing result', value => value.splice(0, 2)],
  ['missing end', value => value.splice(1, 1)],
  ['duplicate result', value => value.splice(1, 0, structuredClone(value[0]))],
  ['duplicate end', value => value.splice(2, 0, structuredClone(value[1]))],
  ['mismatched call', value => { value[1].toolCallId = 'other'; }],
  ['failed result', value => { value[1].isError = true; }],
  ['end before start', value => { [value[0], value[1]] = [value[1], value[0]]; }],
  ['extra output fields', value => { value[0].args.extra = true; }],
  ['invalid finding', value => { value[0].args.findings = [{ path: 'a' }]; }],
  ['missing terminal', value => value.pop()],
  ['nonterminal', value => { value[2].isTerminal = false; }],
  ['error assistant', value => { value[2].messages[0].stopReason = 'error'; }],
  ['aborted assistant', value => { value[2].messages[0].stopReason = 'aborted'; }],
  ['unfulfilled tools', value => { value[2].messages[0].stopReason = 'toolUse'; }],
  ['terminal error message', value => { value[2].messages[0].errorMessage = 'failure'; }],
  ['missing assistant', value => { value[2].messages = []; }],
  ['activity after terminal', value => value.push({ type: 'agent_start' })],
]) test(`OMP fails closed on ${name}`, () => {
  const stream = events(); mutate(stream);
  assert.throws(() => parseOmpReview(encode(stream)), /OMP review/);
});

test('OMP rejects malformed JSONL records', () => {
  for (const output of [encode(events()) + '{', encode(events()) + 'null\n', encode(events()) + '[]\n']) assert.throws(() => parseOmpReview(output), /invalid JSONL/);
});

test('trusted extension narrows active tools, blocks mutation and requires unique submission', async () => {
  const handlers = new Map(); let tool; const active = [];
  const shape = { strict() { return this; }, int() { return this; }, min() { return this; } };
  const zod = Object.fromEntries(['object', 'string', 'enum', 'array', 'number'].map(name => [name, () => shape]));
  reviewExtension({ zod, on: (name, handler) => handlers.set(name, handler), registerTool: definition => { tool = definition; }, setActiveTools: names => active.push(names) });
  await handlers.get('session_start')(); await handlers.get('before_agent_start')();
  assert.deepEqual(active, [REVIEW_TOOLS, REVIEW_TOOLS]);
  for (const name of ['write', 'edit', 'task', 'eval', 'manage_skill', 'mcp__external']) assert.equal(handlers.get('tool_call')({ toolName: name }).block, true);
  for (const name of REVIEW_TOOLS) assert.equal(handlers.get('tool_call')({ toolName: name }), undefined);
  assert.equal(handlers.get('session_stop')().decision, 'block');
  assert.equal((await tool.execute()).details.accepted, true);
  await assert.rejects(tool.execute(), /only be submitted once/);
  assert.equal(handlers.get('session_stop')(), undefined);
});

test('shared redactor handles chunk splits, overlaps and newly added secrets', () => {
  let output = '';
  const redact = secretRedactor(['abc-secret', 'secret'], chunk => { output += chunk; });
  redact.write('before abc-'); redact.write('secret after '); redact.add(['new-key']);
  redact.write('new-'); redact.write('key'); redact.end();
  assert.equal(output, 'before [REDACTED] after [REDACTED]');
  assert.equal(redact.redact('abc-secret and new-key'), '[REDACTED] and [REDACTED]');
});

test('runtime prompt describes tools rather than an OS sandbox and requires final_review', () => {
  const input = prompt({ level: 'xhigh', mode: 'full', base: 'a', scope: 'a', head: 'b', diff: '', currentDiff: '[]' });
  assert.match(input, /UV_CACHE_DIR, UV_PROJECT_ENVIRONMENT/);
  assert.match(input, /never edit repository or staged evidence files/);
  assert.match(input, /not an OS sandbox/);
  assert.match(input, /Submit exactly once with the final_review tool/);
  assert.match(input, /Missing required evidence.*remains a blocker/);
  assert.match(input, /INCOMPLETE fails the run without publishing a native verdict/);
});
