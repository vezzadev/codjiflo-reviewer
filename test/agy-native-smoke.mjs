import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRESETS, normalizePreset } from '../src/commands.mjs';
import { fixture } from './fixture.mjs';

// Opt-in: consumes real Antigravity CLI quota and the runner user's signed-in
// Google account. GitHub publication is real HTTP to the fixture loopback only.
const preset = normalizePreset(process.argv[2] || 'neon-medium');
assert.ok(preset && PRESETS[preset]?.runner === 'agy', 'Choose an Antigravity preset (neon-xhigh, neon-medium, or neon)');
const proof = await mkdtemp(join(tmpdir(), 'codjiflo-agy-native-proof-'));
const source = join(proof, 'source-proof.mjs');
const nonce = randomUUID();
await writeFile(source, `// Read-only native smoke evidence. Do not execute.\nexport const reviewEvidence = ${JSON.stringify(nonce)};\n`, { mode: 0o400 });
const f = await fixture({
  filename: 'notes.txt', oldLine: 'old note', newLine: 'updated note',
  headPrompt: `This is a native runtime acceptance review of a tiny text-only fixture. Inspect the complete diff and touched text. Also read the source evidence file at ${JSON.stringify(source)} using read_file or run_command without executing it. Include the exact reviewEvidence value from that file in your human-readable summary as proof of source consumption; it is deliberately not provided in these instructions. No tests, execution of source, network calls or repository edits. If the notes and these instructions have no concrete blocking defect, return verdict APPROVE with no findings and no resolutions. Do not invent defects in this intentionally text-only fixture.`,
});
let log = '';
let failed = false;
try {
  // Restore user roots so agy keeps its signed-in Google account session while
  // Git's explicit isolated config paths remain in effect.
  const providerEnv = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CODJIFLO_AGY_BIN: process.env.CODJIFLO_AGY_BIN || 'agy',
  };
  log = await f.run({ preset, full: true, providerEnv, timeoutMs: 10 * 60 * 1000 });
  assert.match(log, /── AGY agent started/);
  assert.match(log, /── AGY agent finished: status=SUCCESS/);
  const reviews = f.state.posts.filter(post => post.path.endsWith('/reviews'));
  assert.equal(reviews.length, 1, 'Exactly one native GitHub review must publish');
  assert.equal(reviews[0].body.event, 'APPROVE');
  assert.equal(reviews[0].body.commit_id, f.head);
  assert.ok(reviews[0].body.body.includes(nonce), 'Model-generated review must consume the source evidence');
  const publication = JSON.parse(await readFile(join(f.temp, 'publication.json'), 'utf8'));
  assert.ok(publication, 'Publication artifact must be written');
  console.log(JSON.stringify({ preset, model: PRESETS[preset].model, effort: PRESETS[preset].effort, sourceConsumed: true, nativeReviewPublished: true, head: f.head }));
} catch (error) {
  failed = true;
  const transcript = join(proof, 'failed-stdout.log');
  await writeFile(transcript, log || error.stdout || '', { mode: 0o600 });
  console.error(`Native Antigravity smoke failed; captured stdout retained at ${transcript}`);
  throw error;
} finally {
  await f.close();
  if (!failed) await rm(proof, { recursive: true, force: true });
}
