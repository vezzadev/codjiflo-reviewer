import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schema } from './prompt.mjs';

export async function runProcess(command, args, { cwd, env = process.env, input, stream = false, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    // A separate process group lets a timeout stop CLI-spawned tools as well.
    const processGroup = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: processGroup, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdout.on('data', data => { stdout += data; if (stream) process.stdout.write(data); });
    child.stderr.on('data', data => { stderr += data; if (stream) process.stderr.write(data); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms: ${stderr.slice(-2000)}`));
      else if (code !== 0) reject(new Error(`${command} failed (${signal ?? code}): ${stderr.slice(-2000)}`));
      else resolve(stdout);
    });
  });
}

export async function runReviewer({ preset, prompt, cwd, temp, env = process.env }) {
  if (preset.cli === 'codex') {
    const schemaPath = join(temp, 'schema.json');
    const output = join(temp, 'result.json');
    await writeFile(schemaPath, JSON.stringify(schema));
    await runProcess(env.CODJIFLO_CODEX_BIN || 'codex', [
      'exec', '--model', env.CODJIFLO_SOL_MODEL || preset.model,
      '-c', `model_reasoning_effort="${preset.effort}"`, '--sandbox', 'read-only',
      '--output-schema', schemaPath, '--output-last-message', output, '--json', '-',
    ], { cwd, env, input: prompt, stream: true, timeoutMs: 45 * 60 * 1000 });
    return JSON.parse(await readFile(output, 'utf8'));
  }
  const stdout = await runProcess(env.CODJIFLO_CLAUDE_BIN || 'claude', [
    '--print', '--model', env.CODJIFLO_OPUS_MODEL || preset.model, '--effort', preset.effort,
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
    '--no-session-persistence', '--strict-mcp-config', '--allowedTools', 'Read,Grep,Glob,Bash',
    '--permission-mode', 'dontAsk',
  ], { cwd, env, input: prompt, stream: true, timeoutMs: 45 * 60 * 1000 });
  const events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const result = events.findLast(event => event.type === 'result');
  if (!result || result.is_error || result.subtype !== 'success') throw new Error('Claude did not complete successfully');
  if (!result.structured_output) throw new Error('Claude returned no structured_output');
  return result.structured_output;
}
