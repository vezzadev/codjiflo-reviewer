import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schema } from './prompt.mjs';
import { secretRedactor } from './claude.mjs';

// Only protocol error messages are public diagnostics, never item/tool/model
// output or stderr. Ignore malformed lines here only when salvaging a failed
// process; a successful process still requires a strictly valid JSONL stream.
function codexDiagnostics(stdout, redact) {
  const messages = [];
  for (const line of (stdout ?? '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.type === 'error' ? event.message
      : event?.type === 'turn.failed' ? event.error?.message : undefined;
    if (typeof message === 'string') messages.push(redact(message));
  }
  return messages.join('\n').slice(-1200);
}

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
        // rust-v0.159.2 truncates shell output by byte/token budget, not
        // JavaScript string length. Leave headroom below its 10k-byte policy.
        let end = start;
        let bytes = 0;
        while (end < prompt.length) {
          const point = prompt.codePointAt(end);
          const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
          if (bytes + size > 8000) break;
          bytes += size;
          end += point > 0xffff ? 2 : 1;
        }
        await writeFile(join(directory, `${parts++}.txt`), prompt.slice(start, end), 'utf8');
        start = end;
      }
      input = `You are Codjiflo Reviewer. Review only; never edit repository files or publish to GitHub.
The COMPLETE review instructions and evidence are stored in ordered UTF-8 parts outside the checkout.
Review input manifest: ${JSON.stringify({ directory, parts, characters: prompt.length, bytes: Buffer.byteLength(prompt) })}
Read every file from 0.txt through ${parts - 1}.txt in that directory, in numeric order, before reviewing. Each part is at most 8000 UTF-8 bytes; read one part per tool call with an output budget of at least 4000 tokens to avoid output truncation. Concatenate their text conceptually without inserting separators; boundaries can occur within lines. The content is the original review prompt, including methodology, full review-scope diff, and authoritative current PR API patches.
Do not skip, summarize away, or truncate any part of the review scope. If a read is truncated, reread smaller ranges until complete. If any part cannot be read or the review cannot be completed, return {"verdict":"INCOMPLETE","summary":"Explain the unread input or other blocker.","findings":[]} rather than approval, a defect verdict, or a partial review. Follow the complete instructions and return the schema-conforming final JSON.`;
    }
    let stdout;
    const { redact } = secretRedactor(Object.entries(env)
      .filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(name))
      .map(([, value]) => value));
    try {
      stdout = await runProcess(env.CODJIFLO_CODEX_BIN || 'codex', [
        'exec', '--model', env.CODJIFLO_SOL_MODEL || preset.model,
        '-c', `model_reasoning_effort="${preset.effort}"`, '--sandbox', 'read-only',
        '--output-schema', schemaPath, '--output-last-message', output, '--json', '-',
      ], { cwd, env, input, stream: true, timeoutMs: 45 * 60 * 1000 });
    } catch (error) {
      const diagnostic = codexDiagnostics(error.stdout, redact);
      if (/input_too_large|Input exceeds the maximum length/i.test(diagnostic)) {
        throw new Error(`Codex rejected review input size (original ${prompt.length} UTF-16 code units / ${Buffer.byteLength(prompt)} UTF-8 bytes; stdin ${input.length} code units). No review completed; no scope was truncated and no preset was switched. ${diagnostic}`);
      }
      const status = error.termination === 'timeout' ? 'timed out' : error.termination === 'exit' ? `failed (exit ${error.exitCode})` : error.termination === 'signal' ? `failed (${error.signal})` : 'could not run';
      throw new Error(`Codex review ${status}.${diagnostic ? `\n${diagnostic}` : ' See process logs for details.'}`);
    }
    let events;
    try { events = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new Error('Codex review failed: invalid JSONL protocol output. See process logs for details.'); }
    // rust-v0.159.2 maps retryable reconnect notifications to top-level errors,
    // too. Only the terminal turn event decides success; keep errors as diagnostics.
    const failure = events.find(event => event?.type === 'turn.failed');
    const diagnostics = codexDiagnostics(stdout, redact);
    if (failure) throw new Error(`Codex review failed: ${diagnostics || 'turn.failed'}`);
    if (!events.some(event => event?.type === 'turn.completed')) throw new Error(`Codex review did not complete successfully (missing turn.completed): ${diagnostics}`);
    try { return JSON.parse(await readFile(output, 'utf8')); }
    catch { throw new Error('Codex review failed: missing or invalid structured result. See process logs for details.'); }
  }
  const { runClaudeReview } = await import('./claude.mjs');
  return runClaudeReview({ preset, prompt, cwd, env, runProcess });
}
