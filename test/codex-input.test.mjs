import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture.mjs';
import { prompt } from '../src/prompt.mjs';

const verdicts = f => f.state.posts.filter(post => post.path.endsWith('/reviews'));

async function assertStagedInput(f) {
  const input = await readFile(f.capture + '.stdin', 'utf8');
  assert.ok(input.length < 1048576, 'Codex initial user turn stays below its character cap');
  const manifestLine = input.split('\n').find(line => line.startsWith('Review input manifest: '));
  assert.ok(manifestLine, 'oversized prompt uses complete file-backed transport');
  assert.match(input, /return \{"verdict":"INCOMPLETE"/, 'bootstrap gives an explicit fail-closed verdict even if staged instructions cannot be read');
  const manifest = JSON.parse(manifestLine.slice('Review input manifest: '.length));
  const complete = await readFile(f.capture, 'utf8');
  assert.equal(complete.length, manifest.characters);
  assert.equal(Buffer.byteLength(complete), manifest.bytes);
  assert.ok(complete.length > 1048576, 'original input exceeds the actual Codex turn cap');
  return complete;
}

test('large full and incremental Codex reviews preserve all scope and current API anchors', async () => {
  // A single long UTF-8 line also exercises part boundaries inside a diff line.
  const f = await fixture({ newLine: 'é🙂漢'.repeat(300000) });
  try {
    await f.run({ full: true });
    const complete = await assertStagedInput(f);
    const currentDiff = JSON.stringify(f.state.files.map(file => ({ filename: file.filename, patch: file.patch })), null, 2);
    assert.equal(complete, prompt({ level: 'xhigh', mode: 'full', base: f.base, head: f.head, scope: f.base, diff: f.localDiff, currentDiff }));
    assert.equal(verdicts(f).length, 1);
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');

    f.state.reviews = [{ state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v3 ${JSON.stringify({ head: f.previous, base: f.base, preset: 'sol-xhigh' })} -->` }];
    await f.run();
    const incremental = await assertStagedInput(f);
    assert.ok(incremental.includes(`git diff ${f.previous} ${f.head}`));
    assert.ok(incremental.endsWith(currentDiff), 'full current-PR metadata remains authoritative in incremental mode');
    assert.equal(verdicts(f).length, 2);
    assert.match(verdicts(f)[1].body.body, /Scope: \*\*incremental\*\*/);
  } finally { await f.close(); }
});

test('large custom instructions remain verbatim in file-backed Codex input', async () => {
  const instructions = 'Inspect café 🙂 cancellation.\n'.repeat(45000);
  const f = await fixture({ headPrompt: instructions });
  try {
    await f.run({ full: true });
    const complete = await assertStagedInput(f);
    assert.ok(complete.includes(`--- BEGIN REPOSITORY REVIEW INSTRUCTIONS ---\n${instructions}\n--- END REPOSITORY REVIEW INSTRUCTIONS ---`));
    assert.ok(complete.includes(f.localDiff));
    assert.equal(verdicts(f).length, 1);
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('unread staged Codex input returns INCOMPLETE without publishing a defect verdict', async () => {
  const f = await fixture({ headPrompt: 'Required review instructions.\n'.repeat(20000) });
  try {
    await assert.rejects(f.run({ mode: 'incomplete-input', full: true }));
    const bootstrap = await readFile(f.capture, 'utf8');
    assert.match(bootstrap, /Review input manifest:/);
    assert.match(bootstrap, /return \{"verdict":"INCOMPLETE"/);
    assert.equal(verdicts(f).length, 0);
    assert.match(f.state.posts.at(-1).body.body, /Review incomplete; no defect verdict: A required review input part could not be read/);
  } finally { await f.close(); }
});

test('Codex reconnect errors followed by turn.completed publish the completed review', async () => {
  const f = await fixture();
  try {
    const output = await f.run({ mode: 'reconnect-recovered' });
    assert.match(output, /Reconnecting/);
    assert.equal(verdicts(f).length, 1);
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('Codex failed or missing terminal completion cannot publish a valid-looking result file', async t => {
  for (const mode of ['failed-turn', 'reconnect-failed', 'fatal-error', 'fatal-exit', 'missing-completion', 'input-too-large']) await t.test(mode, async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.run({ mode }));
      assert.equal(verdicts(f).length, 0);
      const failure = f.state.posts.at(-1).body.body;
      assert.match(failure, /failed/);
      if (mode === 'reconnect-failed') {
        assert.match(failure, /Reconnecting/);
        assert.match(failure, /Fixture provider failed/);
      }
      if (mode === 'fatal-error' || mode === 'fatal-exit') assert.match(failure, /Fixture fatal transport error/);
      if (mode === 'input-too-large') {
        assert.match(failure, /1048576/);
        assert.match(failure, /UTF-8 bytes/);
        assert.match(failure, /stdin/);
      }
    } finally { await f.close(); }
  });
});
