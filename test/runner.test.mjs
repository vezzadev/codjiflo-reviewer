import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runProcess } from '../src/runner.mjs';

const execFileAsync = promisify(execFile);
const runnerUrl = new URL('../src/runner.mjs', import.meta.url).href;

test('split UTF-8 bytes are preserved in captured stdout and live stdout/stderr', { timeout: 15000 }, async () => {
  const stdout = 'stdout: café 🙂 漢字\n';
  const stderr = 'stderr: naïve 🚀 日本語\n';
  const childScript = `
    const { setTimeout: delay } = await import('node:timers/promises');
    for (const [stream, text] of [[process.stdout, ${JSON.stringify(stdout)}], [process.stderr, ${JSON.stringify(stderr)}]]) {
      for (const byte of Buffer.from(text)) {
        await new Promise(resolve => stream.write(Buffer.from([byte]), resolve));
        await delay(25);
      }
    }
  `;
  // Capture the wrapper's OS pipes rather than mocking writes in the test runner.
  const wrapper = `
    import { runProcess } from ${JSON.stringify(runnerUrl)};
    const result = await runProcess(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stream: true });
    process.stdout.write(JSON.stringify(result));
  `;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', wrapper], { timeout: 10000 });
  assert.equal(result.stdout, stdout + JSON.stringify(stdout));
  assert.equal(result.stderr, stderr);
});

test('successful commands with a timeout still return their output', async () => {
  assert.equal(await runProcess(process.execPath, ['-e', 'process.stdout.write("done")'], { timeoutMs: 5000 }), 'done');
});

test('timeouts reject and kill descendants even when they ignore SIGTERM', {
  skip: process.platform !== 'linux',
  timeout: 15000,
}, async () => {
  const descendant = `
    process.on('SIGTERM', () => {});
    process.stderr.write('descendant=' + process.pid + '\\n');
    setInterval(() => {}, 60000);
  `;
  const parent = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    setInterval(() => {}, 60000);
  `;
  let descendantPid;
  await assert.rejects(runProcess(process.execPath, ['-e', parent], { timeoutMs: 3000 }), error => {
    assert.equal(error.termination, 'timeout');
    assert.equal(error.exitCode, null);
    assert.equal(error.signal, 'SIGKILL');
    const match = error.message.match(/descendant=(\d+)/);
    assert.ok(match, 'descendant started before the timeout');
    descendantPid = match[1];
    return true;
  });
  try {
    const stat = await readFile(`/proc/${descendantPid}/stat`, 'utf8');
    // A killed orphan can briefly remain as a zombie until PID 1 reaps it.
    assert.match(stat, /^\d+ \(.*\) Z /);
  } catch (error) {
    // procfs can report ESRCH if reaping races an already-open stat file.
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
});

test('nonzero exits reject instead of returning partial output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("partial"); process.stderr.write("failure"); process.exitCode = 7'], {
    timeoutMs: 5000,
  }), error => {
    assert.equal(error.termination, 'exit');
    assert.equal(error.exitCode, 7);
    assert.equal(error.signal, null);
    assert.equal(error.stdout, 'partial');
    return true;
  });
});

test('signal termination preserves the signal separately from exit status', {
  skip: process.platform === 'win32',
}, async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']), error => {
    assert.equal(error.termination, 'signal');
    assert.equal(error.exitCode, null);
    assert.equal(error.signal, 'SIGTERM');
    return true;
  });
});

test('spawn failures preserve the operating system error code', async () => {
  await assert.rejects(runProcess(process.execPath, [], { cwd: '/codjiflo-nonexistent-fixture-directory' }), error => {
    assert.equal(error.termination, 'spawn');
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});
