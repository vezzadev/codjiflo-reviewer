import test from 'node:test';
import assert from 'node:assert/strict';
import { isApproved, parseCommand, requestFromEvent, PRESETS } from '../src/commands.mjs';
import { parseDiff, inlineComment } from '../src/diff.mjs';
import { baseline, validateResult } from '../src/review.mjs';

const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n-old\n+new\n same\n last\n@@ -20 +20 @@\n-before\n+after\n';
const finding = { path: 'a.js', side: 'RIGHT', start_line: 1, line: 2, priority: 'P1', disposition: 'blocking', title: 'Broken result', body: 'Fails for zero. Category: correctness.' };
const marker = (head, base) => `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head, base })} -->`;
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
  const files = parseDiff(diff);
  assert.deepEqual(inlineComment(finding, files), { path: 'a.js', side: 'RIGHT', line: 2, start_line: 1, start_side: 'RIGHT', body: '**[P1] Broken result**\n\nFails for zero. Category: correctness.' });
  const left = inlineComment({ ...finding, side: 'LEFT', line: 1 }, files);
  assert.equal(left.side, 'LEFT');
  assert.equal(left.start_line, undefined);
  assert.throws(() => inlineComment({ ...finding, line: 20 }, files));
  assert.throws(() => inlineComment({ ...finding, path: 'missing' }, files));
  assert.throws(() => inlineComment({ ...finding, line: 0 }, files));
});
test('deleted files and quoted paths retain left-side ranges', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
  assert.equal(inlineComment({ ...finding, side: 'LEFT', line: 1 }, files).line, 1);
  const quoted = parseDiff('diff --git "a/has space" "b/has space"\n--- "a/has space"\n+++ "b/has space"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(quoted.has('has space'), true);
});
test('baseline requires successful bot approval with matching base and pinned commit', () => {
  const approved = { state: 'APPROVED', user: { type: 'Bot' }, body: marker(sha, 'base'), commit_id: sha };
  assert.equal(baseline([approved], 'base').head, sha);
  assert.equal(baseline([approved], 'newbase'), null);
  assert.equal(baseline([{ ...approved, user: { type: 'User' } }], 'base'), null);
  assert.equal(baseline([approved, { ...approved, state: 'CHANGES_REQUESTED' }], 'base'), null);
  assert.equal(baseline([approved, { ...approved, state: 'DISMISSED' }], 'base'), null);
  assert.equal(baseline([{ ...approved, commit_id: 'mismatch' }], 'base'), null);
});
test('malformed or contradictory results cannot approve', () => {
  const files = parseDiff(diff);
  assert.throws(() => validateResult({}, files, 15));
  assert.throws(() => validateResult({ verdict: 'APPROVE', summary: 'ok', findings: [finding] }, files, 15));
  assert.throws(() => validateResult({ verdict: 'APPROVE', summary: '', findings: [] }, files, 15));
  assert.throws(() => validateResult({ verdict: 'REQUEST_CHANGES', summary: 'Found bug', findings: [{ ...finding, disposition: 'unknown' }] }, files, 15));
  assert.equal(validateResult({ verdict: 'APPROVE', summary: 'Advisory only', findings: [{ ...finding, disposition: 'advisory' }] }, files, 15).length, 1);
  assert.equal(validateResult({ verdict: 'REQUEST_CHANGES', summary: 'Found bug', findings: [finding] }, files, 15).length, 1);
});
