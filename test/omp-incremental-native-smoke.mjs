import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, normalizePreset } from '../src/commands.mjs';
import { fixture } from './fixture.mjs';

// Opt-in: real model analysis and native HTTP publication to loopback only.
const preset = normalizePreset(process.argv[2] || 'opus-medium');
assert.ok(preset && Object.hasOwn(PRESETS, preset), 'Choose a supported reviewer preset');
const proof = await mkdtemp(join(tmpdir(), 'codjiflo-incremental-native-'));
const source = join(proof, 'source-proof.txt');
const nonce = randomUUID();
await writeFile(source, nonce, { mode: 0o400 });
const f = await fixture({
  filename: 'settings.txt', oldLine: 'minimum=0', newLine: 'minimum=-1',
  headPrompt: `Review this text configuration against its contract: minimum must be a nonnegative integer. Other lines are free-form notes and have no operational meaning. Inspect the diff and current settings.txt; assess outstanding findings against the actual current file. Report violations of this contract as blocking findings. Do not invent additional requirements. Read ${JSON.stringify(source)} using read or bash, and include its exact contents in your summary as evidence of source consumption. Do not execute source, run tests, edit files, or access the network. Submit your own verdict using final_review.`,
});
const providerEnv = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  CODJIFLO_OMP_BIN: process.env.CODJIFLO_OMP_BIN || 'omp',
};
let failed = false;
let log = '';
const rounds = [];
async function runRound(expectedVerdict, expectedMode) {
  const round = rounds.length + 1;
  const transcript = join(proof, `round-${round}.log`);
  await writeFile(transcript, '', { mode: 0o600 });
  console.log(JSON.stringify({ preset, round, phase: 'review-start', transcript }));
  let pending = '';
  const streamOutput = {
    stdout(text) {
      appendFileSync(transcript, text);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'tool_execution_start') console.log(JSON.stringify({ preset, round, tool: event.toolName }));
        if (event.message?.stopReason === 'error' || /retry|error/.test(event.type)) {
          console.log(JSON.stringify({ preset, round, phase: 'provider-diagnostic', event: event.type, transcript }));
        }
      }
    },
    stderr(text) {
      appendFileSync(transcript, text);
      console.log(JSON.stringify({ preset, round, phase: 'stderr', transcript }));
    },
  };
  log = await f.run({ preset, providerEnv, streamOutput, timeoutMs: 46 * 60 * 1000 });
  const records = log.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const input = records.filter(event => event.type === 'message_end' && event.message?.role === 'user')
    .flatMap(event => event.message.content)
    .find(part => part?.type === 'text' && part.text.includes('Review-scope unified diff follows:\n'))?.text;
  const scopePatch = input?.split('Review-scope unified diff follows:\n')[1]
    ?.split('\nAuthoritative current PR file metadata and patches for location mapping ONLY')[0];
  assert.equal(typeof scopePatch, 'string', 'Observe the scope patch actually delivered to the model');
  const calls = records.filter(event => event.type === 'tool_execution_start');
  const completions = records.filter(event => event.type === 'tool_execution_end');
  assert.ok(calls.some(call => ['read', 'bash'].includes(call.toolName)
    && JSON.stringify(call.args).includes(source)
    && completions.some(end => end.toolCallId === call.toolCallId && end.isError === false && JSON.stringify(end.result).includes(nonce))), 'Model must read the source nonce each round');
  const submissions = calls.filter(call => call.toolName === 'final_review');
  assert.equal(submissions.length, 1);
  const result = submissions[0].args;
  assert.equal(result.verdict, expectedVerdict);
  assert.ok(result.summary.includes(nonce));
  const posts = f.state.posts.filter(post => post.path.endsWith('/reviews'));
  assert.equal(posts.length, rounds.length + 1);
  const payload = posts.at(-1).body;
  assert.equal(payload.event, expectedVerdict);
  assert.equal(payload.commit_id, f.state.head ?? f.head);
  assert.ok(payload.body.includes(`Scope: **${expectedMode}**`));
  const marker = /<!-- codjiflo-reviewer:v4 (\{[^\n]+\}) -->/.exec(payload.body);
  assert.ok(marker, 'Published review must carry the durable checkpoint');
  const checkpoint = JSON.parse(marker[1]);
  const retained = JSON.parse(await readFile(join(f.temp, 'publication.json'), 'utf8'));
  assert.equal(retained.payload.body, payload.body);
  rounds.push({ head: payload.commit_id, verdict: expectedVerdict, mode: expectedMode, findings: checkpoint.findings.length });
  return { result, checkpoint, scopePatch };
}
try {
  const first = await runRound('REQUEST_CHANGES', 'full');
  assert.ok(first.checkpoint.findings.some(finding => finding.disposition === 'blocking'));
  assert.deepEqual(first.result.resolutions, []);
  const priorIds = first.checkpoint.findings.map(finding => finding.id).sort();
  const notes = 'changed\n' + 'context\n'.repeat(7) + 'Unrelated note updated.\n';
  await f.advance({ 'settings.txt': 'minimum=-1\n' + notes });
  const second = await runRound('REQUEST_CHANGES', 'incremental');
  assert.doesNotMatch(second.scopePatch, /minimum=/, 'The old defect must be absent even from incremental hunk context');
  assert.ok(second.scopePatch.includes('+Unrelated note updated.'));
  assert.deepEqual(second.result.findings, [], 'An unchanged prior blocker must not be reported as a new finding');
  assert.deepEqual(second.checkpoint.findings.map(finding => finding.id).sort(), priorIds);
  assert.deepEqual(second.result.resolutions.map(resolution => resolution.id).sort(), priorIds);
  assert.ok(second.result.resolutions.some(resolution => resolution.status === 'unresolved'));
  assert.ok(second.checkpoint.findings.some(finding => priorIds.includes(finding.id) && finding.disposition === 'blocking'));
  await f.advance({ 'settings.txt': 'minimum=0\n' + notes });
  const third = await runRound('APPROVE', 'incremental');
  assert.deepEqual(third.result.resolutions.map(resolution => resolution.id).sort(), second.checkpoint.findings.map(finding => finding.id).sort());
  assert.ok(third.result.resolutions.every(resolution => resolution.status === 'resolved'));
  assert.deepEqual(third.checkpoint.findings, []);
  console.log(JSON.stringify({ preset, sourceConsumedEveryRound: true, defectOutsideIncrementalPatch: true, nativePublicationEveryRound: true, rounds }));
} catch (error) {
  failed = true;
  const transcript = join(proof, 'failed-stdout.log');
  await writeFile(transcript, error.stdout || log, { mode: 0o600 });
  console.error(`Incremental native smoke failed; stdout retained at ${transcript}`);
  throw error;
} finally {
  await f.close();
  if (!failed) await rm(proof, { recursive: true, force: true });
}
