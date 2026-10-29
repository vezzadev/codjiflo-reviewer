import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PRESETS, normalizePreset } from '../src/commands.mjs';
import { REVIEW_TOOLS } from '../src/omp-review-extension.mjs';
import { fixture } from './fixture.mjs';

// Opt-in: consumes real OMP quota and normal shared OMP credentials. GitHub
// publication is real HTTP to the fixture's loopback server, never github.com.
const preset = normalizePreset(process.argv[2] || 'sol-medium');
assert.ok(preset && Object.hasOwn(PRESETS, preset), 'Choose a supported reviewer preset');
const proof = await mkdtemp(join(tmpdir(), 'codjiflo-omp-native-proof-'));
const source = join(proof, 'source-proof.mjs');
const nonce = randomUUID();
await writeFile(source, `// Read-only native smoke evidence. Do not execute.\nexport const reviewEvidence = ${JSON.stringify(nonce)};\n`, { mode: 0o400 });
const f = await fixture({
  filename: 'notes.txt', oldLine: 'old note', newLine: 'updated note',
  headPrompt: `This is a native runtime acceptance review of a tiny text-only fixture. Inspect the complete diff and touched text. Also read the source evidence file at ${JSON.stringify(source)} using read or bash without executing it. Include the exact reviewEvidence value from that file in your human-readable summary as proof of source consumption; it is deliberately not provided in these instructions. No tests, execution of source, network calls or repository edits. If the notes and these instructions have no concrete blocking defect, submit APPROVE with no findings using final_review exactly once. Do not invent defects in this intentionally text-only fixture. End with a short acknowledgement.`,
});
let log = '';
let failed = false;
try {
  // The Git fixture isolates HOME for git configuration. Restore only the normal
  // user roots for the native reviewer so OMP keeps its real shared auth store.
  // Git's explicit isolated config paths remain in effect.
  const providerEnv = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CODJIFLO_OMP_BIN: process.env.CODJIFLO_OMP_BIN || 'omp',
  };
  log = await f.run({ preset, full: true, providerEnv, timeoutMs: 46 * 60 * 1000 });
  const records = log.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = records.filter(event => event.type === 'tool_execution_start');
  const completions = records.filter(event => event.type === 'tool_execution_end');
  assert.ok(calls.every(call => REVIEW_TOOLS.includes(call.toolName)), 'Every actually executed tool must belong to the review allowlist');
  const sourceRead = calls.find(call => ['read', 'bash'].includes(call.toolName)
    && JSON.stringify(call.args).includes(source)
    && completions.some(end => end.toolCallId === call.toolCallId && end.isError === false && JSON.stringify(end.result).includes(nonce)));
  assert.ok(sourceRead, 'Real OMP must read the nonce from source via an allowed tool');
  const final = calls.filter(call => call.toolName === 'final_review');
  assert.equal(final.length, 1);
  assert.ok(final[0].args.summary.includes(nonce), 'Model-generated review must consume the source evidence');
  assert.equal(final[0].args.verdict, 'APPROVE');
  const assistants = records.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
  assert.ok(assistants.length, 'Real OMP assistant event evidence is required');
  let declaredToolMessages = 0;
  for (const message of assistants) {
    const tools = message.requestControls?.tools;
    // Anthropic exposes requestControls; OpenAI Codex responses may omit it.
    // Validate observed declarations without claiming missing metadata proves
    // the unobserved tool surface. Executed-tool checks above apply to both.
    if (tools?.declared === undefined && PRESETS[preset].provider === 'openai-codex') {
      if (tools?.active !== undefined) assert.ok(Array.isArray(tools.active) && tools.active.every(tool => REVIEW_TOOLS.includes(tool)), 'Observed active tools must be restricted');
      continue;
    }
    assert.ok(Array.isArray(tools?.declared), 'OMP must expose valid request tool declarations when metadata is available');
    assert.ok(tools.declared.includes('final_review'), 'Trusted completion tool must reach the model');
    assert.ok(tools.declared.every(tool => REVIEW_TOOLS.includes(tool)), `Unexpected declared tool: ${tools.declared.join(',')}`);
    assert.ok(Array.isArray(tools.active) && tools.active.every(tool => REVIEW_TOOLS.includes(tool)), 'Active tool set must be restricted');
    declaredToolMessages++;
  }
  const terminal = records.filter(event => event.type === 'agent_end').at(-1);
  assert.equal(terminal?.isTerminal, true);
  assert.equal(terminal.messages.filter(message => message.role === 'assistant').at(-1)?.stopReason, 'stop');
  const reviews = f.state.posts.filter(post => post.path.endsWith('/reviews'));
  assert.equal(reviews.length, 1, 'Exactly one native GitHub review must publish');
  assert.equal(reviews[0].body.event, 'APPROVE');
  assert.equal(reviews[0].body.commit_id, f.head);
  assert.ok(reviews[0].body.body.includes(nonce));
  const publication = JSON.parse(await readFile(join(f.temp, 'publication.json'), 'utf8'));
  assert.ok(publication, 'Publication artifact must be written');
  const credentialIds = [...new Set(assistants.map(message => message.credentialId).filter(id => id !== undefined))];
  // Persist only to an explicitly requested local file. Useful for a parent-run
  // account-switch experiment; no credentials or raw transcript are included.
  const evidence = { preset, model: PRESETS[preset].model, credentialIds, sourceConsumed: true, finalReviewSubmitted: true, terminalSuccess: true, nativeReviewPublished: true, executedToolsRestricted: true, declaredToolEvidence: declaredToolMessages === assistants.length ? 'complete' : declaredToolMessages ? 'partial' : 'unavailable', declaredToolMessages, assistantMessages: assistants.length, head: f.head };
  if (process.env.CODJIFLO_NATIVE_SMOKE_EVIDENCE) await writeFile(resolve(process.env.CODJIFLO_NATIVE_SMOKE_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} catch (error) {
  failed = true;
  const transcript = join(proof, 'failed-stdout.log');
  await writeFile(transcript, log || error.stdout || '', { mode: 0o600 });
  console.error(`Native OMP smoke failed; captured stdout retained at ${transcript}`);
  throw error;
} finally {
  await f.close();
  if (!failed) await rm(proof, { recursive: true, force: true });
}
