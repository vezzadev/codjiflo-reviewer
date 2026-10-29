import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewer } from '../src/runner.mjs';
import { validateResult } from '../src/review.mjs';
import { prompt } from '../src/prompt.mjs';

const preset = { cli: 'codex', model: 'fixture', effort: 'high' };
const runtimeNames = ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'UV_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT', 'PYTHONPYCACHEPREFIX'];

// This fixture checks the native launch contract, not OS sandbox enforcement.
// The live Codex smoke must separately exercise allowed scratch/denied repo writes.
async function setup(mode) {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-runtime-test-'));
  const cwd = join(temp, 'repository');
  await mkdir(cwd);
  const capture = join(temp, 'capture.json');
  const cli = join(temp, 'codex.mjs');
  await writeFile(cli, `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
for await (const chunk of process.stdin) {}
const names = ${JSON.stringify(runtimeNames)};
await writeFile(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(names.map(name => [name, process.env[name]])), cwd: process.cwd() }));
for (const name of names) {
  await mkdir(process.env[name], { recursive: true });
  await writeFile(join(process.env[name], 'runtime-lock'), 'private');
}
if (process.env.MODE === 'exit') process.exit(7);
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
await writeFile(output, JSON.stringify({ verdict: 'INCOMPLETE', summary: 'Required SDK source unavailable.', findings: [] }));
if (process.env.MODE !== 'missing-completion') console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  await chmod(cli, 0o755);
  const env = { ...process.env, CODJIFLO_CODEX_BIN: cli, CAPTURE: capture, MODE: mode, ...Object.fromEntries(runtimeNames.map(name => [name, '/host/runtime-must-not-be-used'])) };
  return { temp, cwd, capture, env, run: () => runReviewer({ preset, prompt: 'Review completely or return INCOMPLETE.', cwd, temp, env }) };
}

test('Codex grants only private scratch writes while preserving incomplete semantics', async () => {
  const f = await setup('complete');
  try {
    const originalEnv = { ...f.env };
    const result = await f.run();
    assert.equal(result.verdict, 'INCOMPLETE');
    assert.throws(() => validateResult(result, new Map(), 15), /Review incomplete/);
    assert.deepEqual(f.env, originalEnv, 'caller environment is not mutated');
    const { args, env, cwd } = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.equal(cwd, await realpath(f.cwd));
    assert.ok(args.includes('--strict-config'), 'unsupported permission keys must not be silently ignored');
    for (const forbidden of ['--sandbox', '--add-dir', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(!args.includes(forbidden));
    const config = args.filter((_, index) => args[index - 1] === '-c');
    assert.ok(config.includes('approval_policy="never"'));
    const selected = JSON.parse(config.find(value => value.startsWith('default_permissions=')).slice('default_permissions='.length));
    const policy = config.find(value => value.startsWith(`permissions.${selected}=`));
    const scratch = join(await realpath(f.temp), selected);
    assert.equal(policy, `permissions.${selected}={extends=":read-only",filesystem={${JSON.stringify(scratch)}="write"},network={enabled=false}}`);
    assert.ok(relative(await realpath(f.cwd), scratch).startsWith('..' + sep));
    for (const name of runtimeNames) {
      assert.ok(env[name].startsWith(scratch + sep), `${name} is private`);
      assert.ok(config.includes(`shell_environment_policy.set.${name}=${JSON.stringify(env[name])}`), `${name} survives shell environment filtering`);
    }
    assert.equal(env.TMP, env.TMPDIR);
    assert.equal(env.TEMP, env.TMPDIR);
    await assert.rejects(readFile(join(env.UV_CACHE_DIR, 'runtime-lock')), { code: 'ENOENT' });
    const firstScratch = scratch;
    await f.run();
    const second = JSON.parse(await readFile(f.capture, 'utf8'));
    assert.ok(!second.env.TMPDIR.startsWith(firstScratch + sep), 'each invocation has isolated scratch');
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('Codex cleans scratch on process failure and still rejects missing terminal completion', async t => {
  for (const mode of ['exit', 'missing-completion']) await t.test(mode, async () => {
    const f = await setup(mode);
    try {
      await assert.rejects(f.run(), mode === 'exit' ? /failed \(exit 7\)/ : /missing turn.completed/);
      const { env } = JSON.parse(await readFile(f.capture, 'utf8'));
      await assert.rejects(readFile(join(env.TMPDIR, 'runtime-lock')), { code: 'ENOENT' });
    } finally { await rm(f.temp, { recursive: true, force: true }); }
  });
});

test('Codex rejects scratch parents inside the checkout, including symlink aliases', async () => {
  const f = await setup('complete');
  try {
    const nested = join(f.cwd, 'nested');
    await mkdir(nested);
    const alias = join(f.temp, 'alias');
    await symlink(nested, alias, 'dir');
    for (const temp of [f.cwd, nested, alias]) {
      await assert.rejects(runReviewer({ preset, prompt: 'Review.', cwd: f.cwd, temp, env: f.env }), /outside the checkout/);
    }
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
  } finally { await rm(f.temp, { recursive: true, force: true }); }
});

test('runtime instructions permit prerequisite scratch but never waive required evidence', () => {
  const input = prompt({ level: 'xhigh', mode: 'full', base: 'a', scope: 'a', head: 'b', diff: '', currentDiff: '[]' });
  assert.match(input, /UV_CACHE_DIR, UV_PROJECT_ENVIRONMENT/);
  assert.match(input, /never edit repository or staged evidence files/);
  assert.match(input, /Missing required evidence.*remains a blocker/);
  assert.match(input, /INCOMPLETE fails the run without publishing a native verdict/);
});
