import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schema } from './prompt.mjs';

export async function runProcess(command, args, { cwd, env = process.env, input, stream = false, streamOutput, timeoutMs } = {}) {
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
    child.stdout.on('data', data => { stdout += data; if (stream) (streamOutput?.stdout ?? (text => process.stdout.write(text)))(data); });
    child.stderr.on('data', data => { stderr += data; if (stream) (streamOutput?.stderr ?? (text => process.stderr.write(text)))(data); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms: ${stderr.slice(-2000)}`));
      else if (code !== 0) reject(Object.assign(new Error(`${command} failed (${signal ?? code}): ${stderr.slice(-2000)}`), { stdout }));
      else resolve(stdout);
    });
  });
}

export async function runReviewer({ preset, prompt, cwd, temp, env = process.env }) {
  if (preset.cli === 'codex') {
    const schemaPath = join(temp, 'schema.json');
    const output = join(temp, 'result.json');
    await writeFile(schemaPath, JSON.stringify(schema));
    // Codex caps a user turn at 1,048,576 characters, independently of context
    // capacity. Keep a conservative margin and transport the COMPLETE input as
    // bounded UTF-8 files, including custom instructions and both diff forms.
    let input = prompt;
    if (prompt.length > 512 * 1024) {
      const directory = await mkdtemp(join(temp, 'review-input-'));
      let parts = 0;
      for (let start = 0; start < prompt.length;) {
        let end = Math.min(start + 8000, prompt.length);
        const last = prompt.charCodeAt(end - 1);
        if (end < prompt.length && last >= 0xd800 && last <= 0xdbff) end--;
        await writeFile(join(directory, `${parts++}.txt`), prompt.slice(start, end), 'utf8');
        start = end;
      }
      input = `You are Codjiflo Reviewer. Review only; never edit repository files or publish to GitHub.
The COMPLETE review instructions and evidence are stored in ordered UTF-8 parts outside the checkout.
Review input manifest: ${JSON.stringify({ directory, parts, characters: prompt.length, bytes: Buffer.byteLength(prompt) })}
Read every file from 0.txt through ${parts - 1}.txt in that directory, in numeric order, before reviewing. Each part is at most 8000 characters; read one part per tool call to avoid output truncation. Concatenate their text conceptually without inserting separators; boundaries can occur within lines. The content is the original review prompt, including methodology, full review-scope diff, and authoritative current PR API patches.
Do not skip, summarize away, or truncate any part of the review scope. If a read is truncated, reread smaller ranges until complete. If any part cannot be read or the review cannot be completed, return {"verdict":"INCOMPLETE","summary":"Explain the unread input or other blocker.","findings":[]} rather than approval, a defect verdict, or a partial review. Follow the complete instructions and return the schema-conforming final JSON.`;
    }
    let stdout;
    try {
      stdout = await runProcess(env.CODJIFLO_CODEX_BIN || 'codex', [
        'exec', '--model', env.CODJIFLO_SOL_MODEL || preset.model,
        '-c', `model_reasoning_effort="${preset.effort}"`, '--sandbox', 'read-only',
        '--output-schema', schemaPath, '--output-last-message', output, '--json', '-',
      ], { cwd, env, input, stream: true, timeoutMs: 45 * 60 * 1000 });
    } catch (error) {
      const diagnostic = `${error.message}\n${error.stdout ?? ''}`;
      if (/input_too_large|Input exceeds the maximum length/i.test(diagnostic)) {
        throw new Error(`Codex rejected review input size (original ${prompt.length} UTF-16 code units / ${Buffer.byteLength(prompt)} UTF-8 bytes; stdin ${input.length} code units). No review completed; no scope was truncated and no preset was switched. ${diagnostic.slice(-900)}`);
      }
      if (error.stdout) error.message += `\nCodex JSONL diagnostics: ${error.stdout.slice(-1200)}`;
      throw error;
    }
    const events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    // rust-v0.159.2 maps retryable reconnect notifications to top-level errors,
    // too. Only the terminal turn event decides success; keep errors as diagnostics.
    const failure = events.find(event => event.type === 'turn.failed');
    const diagnostics = events.filter(event => event.type === 'turn.failed' || event.type === 'error');
    if (failure) throw new Error(`Codex review failed: ${JSON.stringify(diagnostics).slice(-1200)}`);
    if (!events.some(event => event.type === 'turn.completed')) throw new Error(`Codex review did not complete successfully (missing turn.completed): ${JSON.stringify(diagnostics).slice(-1200)}`);
    return JSON.parse(await readFile(output, 'utf8'));
  }
  const { runClaudeReview } = await import('./claude.mjs');
  return runClaudeReview({ preset, prompt, cwd, env, runProcess });
}
