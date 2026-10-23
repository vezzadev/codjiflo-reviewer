import test from 'node:test';
import assert from 'node:assert/strict';
import { isApproved, parseCommand, requestFromEvent, PRESETS } from '../src/commands.mjs';
import { filesFromApi, inlineComment } from '../src/diff.mjs';
import { baseline, validateResult } from '../src/review.mjs';
import { fixture } from './fixture.mjs';

const metadata = [{ filename: 'a.js', additions: 2, deletions: 2, patch: '@@ -1,3 +1,3 @@\n-old\n+new\n same\n last\n@@ -20 +20 @@\n-before\n+after\n' }];
const finding = { path: 'a.js', side: 'RIGHT', start_line: 1, line: 2, priority: 'P1', disposition: 'blocking', title: 'Broken result', body: 'Fails for zero. Category: correctness.' };
const marker = (head, base, preset = 'sol-high') => `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head, base, preset })} -->`;
const sha = 'a'.repeat(40);

test('authorization denies empty, absent and non-exact users; normalizes login case', () => {
  assert.equal(isApproved('alice'), false);
  assert.equal(isApproved('alice', ''), false);
  assert.equal(isApproved('ali', 'alice'), false);
  assert.equal(isApproved('Alice', 'bob, ALICE\ncarol'), true);
  assert.equal(isApproved(undefined, 'alice'), false);
});
test('commands support four presets, aliases, explicit full and default incremental', () => {
  assert.deepEqual(parseCommand('@codjiflo-reviewer review'), { preset: 'sol-high', mode: 'incremental' });
  for (const preset of Object.keys(PRESETS)) assert.deepEqual(parseCommand(`@codjiflo review ${preset} full`), { preset, mode: 'full' });
  assert.equal(parseCommand('not a review'), null);
  assert.throws(() => parseCommand('@codjiflo review turbo'));
  assert.throws(() => parseCommand('@codjiflo review full incremental'));
});
test('event authorization uses original comment sender, not rerunner actor', () => {
  const event = { action: 'created', sender: { login: 'admin' }, comment: { body: '@codjiflo-reviewer review', user: { login: 'stranger' } }, repository: { full_name: 'org/repo' }, issue: { number: 1, pull_request: {} } };
  assert.equal(requestFromEvent(event, 'admin'), null);
  event.comment.user.login = 'ADMIN';
  assert.equal(requestFromEvent(event, 'admin').requester, 'ADMIN');
  assert.equal(requestFromEvent({ ...event, action: 'edited' }, 'admin'), null);
});
test('ranged comments retain correct left and right coordinates', () => {
  const files = filesFromApi(metadata);
  assert.deepEqual(inlineComment(finding, files), { path: 'a.js', side: 'RIGHT', line: 2, start_line: 1, start_side: 'RIGHT', body: '**[P1] Broken result**\n\nFails for zero. Category: correctness.' });
  const left = inlineComment({ ...finding, side: 'LEFT', line: 1 }, files);
  assert.equal(left.side, 'LEFT');
  assert.equal(left.start_line, undefined);
  assert.throws(() => inlineComment({ ...finding, line: 20 }, files));
  assert.throws(() => inlineComment({ ...finding, path: 'missing' }, files));
  assert.throws(() => inlineComment({ ...finding, line: 0 }, files));
});
test('removed files retain legal left-side comments and reject right-side anchors', () => {
  const files = filesFromApi([{ filename: 'a.js', status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-gone\n' }]);
  assert.equal(inlineComment({ ...finding, side: 'LEFT', line: 1 }, files).line, 1);
  assert.throws(() => inlineComment({ ...finding, side: 'RIGHT', line: 1 }, files));
});
test('baseline accepts PAT or bot approval, pins commit/base/preset, and respects latest blockers', () => {
  const approved = { state: 'APPROVED', user: { type: 'Bot' }, body: marker(sha, 'base'), commit_id: sha };
  assert.equal(baseline([approved], 'base', 'sol-high').head, sha);
  assert.equal(baseline([approved], 'newbase', 'sol-high'), null);
  assert.equal(baseline([approved], 'base', 'opus-high'), null);
  const pat = { ...approved, user: { type: 'User' } };
  assert.equal(baseline([pat], 'base', 'sol-high').head, sha);
  assert.equal(baseline([approved, { ...pat, state: 'CHANGES_REQUESTED' }], 'base', 'sol-high'), null);
  assert.equal(baseline([approved, { ...approved, state: 'DISMISSED' }], 'base', 'sol-high'), null);
  assert.equal(baseline([{ ...approved, commit_id: 'mismatch' }], 'base', 'sol-high'), null);
});
test('malformed or contradictory results cannot approve', () => {
  const files = filesFromApi(metadata);
  assert.throws(() => validateResult({}, files, 15));
  assert.throws(() => validateResult({ verdict: 'APPROVE', summary: 'ok', findings: [finding] }, files, 15));
  assert.throws(() => validateResult({ verdict: 'APPROVE', summary: '', findings: [] }, files, 15));
  assert.throws(() => validateResult({ verdict: 'REQUEST_CHANGES', summary: 'Found bug', findings: [{ ...finding, disposition: 'unknown' }] }, files, 15));
  assert.equal(validateResult({ verdict: 'APPROVE', summary: 'Advisory only', findings: [{ ...finding, disposition: 'advisory' }] }, files, 15).length, 1);
  assert.equal(validateResult({ verdict: 'REQUEST_CHANGES', summary: 'Found bug', findings: [finding] }, files, 15).length, 1);
});

test('API filenames preserve spaces and Unicode while real Git SQL patches retain anchors', async t => {
  for (const filename of ['has space.sql', 'é\t"quoted".sql']) await t.test(filename, async () => {
    const f = await fixture({ filename, oldLine: '-- old SQL comment', newLine: '++ new SQL content' });
    try {
      const files = filesFromApi(f.state.files);
      assert.equal(files.size, 1);
      assert.equal(inlineComment({ ...finding, path: filename, start_line: 1, line: 1, side: 'LEFT' }, files).path, filename);
      assert.equal(inlineComment({ ...finding, path: filename, start_line: 1, line: 1 }, files).path, filename);
    } finally { await f.close(); }
  });
});

test('API rename coordinates always use filename, including old-side comments', async () => {
  const f = await fixture({ previousFilename: 'old name.js', filename: 'new name.js' });
  try {
    assert.match(f.localDiff, /rename from old name.js/);
    const files = filesFromApi(f.state.files);
    assert.equal(files.get('new name.js').previousPath, 'old name.js');
    assert.equal(inlineComment({ ...finding, path: 'new name.js', side: 'LEFT', start_line: 1, line: 1 }, files).path, 'new name.js');
    assert.throws(() => inlineComment({ ...finding, path: 'old name.js', side: 'LEFT', start_line: 1, line: 1 }, files));
  } finally { await f.close(); }
});

test('left anchors reject context; ranges require legal endpoints, not deleted interiors', () => {
  const files = filesFromApi([{ filename: 'a.js', additions: 2, deletions: 2, patch: '@@ -1,3 +1,3 @@\n-old\n+new\n context\n-last\n+next' }]);
  assert.throws(() => inlineComment({ ...finding, side: 'LEFT', start_line: 2, line: 2 }, files));
  assert.equal(inlineComment({ ...finding, start_line: 2, line: 2 }, files).line, 2);
  assert.equal(inlineComment({ ...finding, side: 'LEFT', start_line: 1, line: 3 }, files).start_line, 1);
});

test('missing and truncated API patches downgrade unanchorable findings into a changes-request summary', () => {
  for (const patch of [undefined, '@@ -1,2 +1,2 @@\n-old\n+new', '@@ -1 +1 @@\n-old\n+new']) {
    const files = filesFromApi([{ filename: 'a.js', additions: 2, deletions: 2, patch }]);
    const result = { verdict: 'APPROVE', summary: 'Review complete.', findings: [{ ...finding, disposition: 'advisory' }] };
    assert.deepEqual(validateResult(result, files, 10), []);
    assert.equal(result.verdict, 'REQUEST_CHANGES');
    assert.match(result.summary, /Broken result/);
    assert.match(result.summary, /Fails for zero/);
  }
});
