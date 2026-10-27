import test from 'node:test';
import assert from 'node:assert/strict';
import { isApproved, parseCommand, eventDecision, PRESETS } from '../src/commands.mjs';
import { filesFromApi, inlineComment } from '../src/diff.mjs';
import { baseline, validateResult } from '../src/review.mjs';
import { fixture } from './fixture.mjs';

const metadata = [{ filename: 'a.js', additions: 2, deletions: 2, patch: '@@ -1,3 +1,3 @@\n-old\n+new\n same\n last\n@@ -20 +20 @@\n-before\n+after\n' }];
const finding = { path: 'a.js', side: 'RIGHT', start_line: 1, line: 2, priority: 'P1', disposition: 'blocking', title: 'Broken result', body: 'Fails for zero. Category: correctness.' };
const marker = (head, base, preset = 'sol-xhigh') => `<!-- codjiflo-reviewer:v3 ${JSON.stringify({ head, base, preset })} -->`;
const sha = 'a'.repeat(40);

test('authorization denies empty, absent and non-exact users; normalizes login case', () => {
  assert.equal(isApproved('alice'), false);
  assert.equal(isApproved('alice', ''), false);
  assert.equal(isApproved('ali', 'alice'), false);
  assert.equal(isApproved('Alice', 'bob, ALICE\ncarol'), true);
  assert.equal(isApproved(undefined, 'alice'), false);
});
test('commands support four presets, aliases, explicit full and default incremental', () => {
  assert.deepEqual(Object.keys(PRESETS), ['sol-xhigh', 'opus-xhigh', 'sol-medium', 'opus-medium']);
  assert.deepEqual(parseCommand('@codjiflo-reviewer review'), { preset: 'sol-xhigh', mode: 'incremental' });
  for (const preset of Object.keys(PRESETS)) assert.deepEqual(parseCommand(`@codjiflo review ${preset} full`), { preset, mode: 'full' });
  for (const [alias, preset] of [['CoDeX', 'sol-xhigh'], ['CLAUDE', 'opus-xhigh']]) {
    assert.deepEqual(parseCommand(`@codjiflo review ${alias}`), { preset, mode: 'incremental' });
    assert.deepEqual(parseCommand(`@codjiflo review FULL ${alias}`), { preset, mode: 'full' });
    for (const options of [`${alias} ${preset}`, `${preset} ${alias}`, `${alias} ${alias}`, `${alias} sol-medium`]) {
      assert.throws(() => parseCommand(`@codjiflo review ${options}`));
    }
  }
  assert.throws(() => parseCommand('@codjiflo review codex claude'));
  for (const preset of ['sol-high', 'opus-high']) assert.throws(() => parseCommand(`@codjiflo review ${preset}`));
  assert.equal(parseCommand('not a review'), null);
  assert.throws(() => parseCommand('@codjiflo review turbo'));
  assert.throws(() => parseCommand('@codjiflo review full incremental'));
});
test('profile shorthand normalizes aliases and canonical names with optional mode', () => {
  for (const [name, preset] of [...Object.keys(PRESETS).map(preset => [preset, preset]), ['codex', 'sol-xhigh'], ['claude', 'opus-xhigh']]) {
    for (const mention of ['@codjiflo', '@codjiflo-reviewer']) {
      assert.deepEqual(parseCommand(`${mention} ${name}`), { preset, mode: 'incremental' });
      assert.deepEqual(parseCommand(`Context\n \t${mention.toUpperCase()} ${name.toUpperCase()} FULL\nThanks`), { preset, mode: 'full' });
      assert.deepEqual(parseCommand(`${mention} ${name} incremental`), { preset, mode: 'incremental' });
    }
    for (const options of [`${name} ${name}`, `${name} ${preset}`, `${name} claude`, `${name} full incremental`, `${name} full full`, `${name} turbo`, `${name} review`]) {
      assert.throws(() => parseCommand(`@codjiflo ${options}`));
    }
  }
});
test('explicit commands work after prose while casual mentions and quoted examples stay inert', () => {
  for (const body of [undefined, '', '@codjiflo', '@codjiflo-reviewer', '@codjiflo thanks', '@codjiflo turbo', '@codjiflo sol-high full', '@codjiflo full', 'Thanks @codjiflo for reviewing', '> @codjiflo claude full', '  > quoted @codjiflo codex', '`@codjiflo codex`', 'Example: ``@codjiflo review``', '```\n@codjiflo codex\n```', '~~~markdown\n@codjiflo review\n~~~', '```text\n@codjiflo codex', '@codjiflo-other codex', 'email@codjiflo codex', '@codjiflo codexish', '@codjiflo\ncodex', '@codjiflo\nreview']) {
    assert.equal(parseCommand(body), null);
  }
  assert.deepEqual(parseCommand('@codjiflo thanks\n@codjiflo codex'), { preset: 'sol-xhigh', mode: 'incremental' });
  assert.deepEqual(parseCommand('@codjiflo review'), { preset: 'sol-xhigh', mode: 'incremental' });
  assert.deepEqual(parseCommand('@codjiflo review FULL'), { preset: 'sol-xhigh', mode: 'full' });
  for (const body of ['Owner authorized option (A) (...). @codjiflo codex', 'Thanks @codjiflo codex', 'Please @CODJIFLO-REVIEWER review', '```text\n@codjiflo claude\n```\nPlease @codjiflo codex', '> @codjiflo claude\nPlease @codjiflo codex', '`example` @codjiflo codex']) {
    assert.deepEqual(parseCommand(body), { preset: 'sol-xhigh', mode: 'incremental' });
  }
  assert.deepEqual(parseCommand('Owner authorized. @codjiflo claude full'), { preset: 'opus-xhigh', mode: 'full' });
  assert.deepEqual(parseCommand('Thanks @codjiflo for the earlier pass. Please @codjiflo codex'), { preset: 'sol-xhigh', mode: 'incremental' });
  assert.equal(parseCommand('Please @codjiflo codex turbo'), null);
});
test('casual profile and review mentions do not fail or hide later commands', () => {
  for (const body of ['Could @codjiflo review this?', 'Thanks @codjiflo claude did great', 'Please @codjiflo codex turbo']) {
    assert.equal(parseCommand(body), null);
    assert.deepEqual(parseCommand(`${body}\n@codjiflo codex`), { preset: 'sol-xhigh', mode: 'incremental' });
  }
  for (const body of ['@codjiflo review this?', '@codjiflo claude did great', 'Context\n@codjiflo codex turbo', '  @codjiflo review full full']) {
    assert.throws(() => parseCommand(body), /Invalid review command/);
  }
});
test('Markdown code spans stop at paragraphs and indented code respects paragraph context', () => {
  for (const body of [
    '    @codjiflo codex',
    '\t@codjiflo codex',
    'Example:\n\n    @codjiflo codex',
    'Example:\n\n    @codjiflo review turbo\n    @codjiflo claude full',
    '`example\n@codjiflo codex\n`',
    '``example `\n@codjiflo codex\n``',
    '    ```\n    @codjiflo codex\n    ```',
  ]) assert.equal(parseCommand(body), null, body);
  for (const body of [
    '`unmatched\n\n@codjiflo codex\n\n`',
    '``unmatched\n \t\n@codjiflo codex\n\n``',
    'Example:\n    @codjiflo codex',
    'Example:\n\t@codjiflo codex',
    '    @codjiflo claude\n\n@codjiflo codex',
    '    @codjiflo claude\n@codjiflo codex',
    'Example:\n\n    @codjiflo claude\n\nOwner authorized option (A). @codjiflo codex',
  ]) assert.deepEqual(parseCommand(body), { preset: 'sol-xhigh', mode: 'incremental' }, body);
});
test('shorthand events require an approved original author and a newly created PR comment', () => {
  const event = { action: 'created', sender: { login: 'admin' }, comment: { body: '@codjiflo codex', user: { login: 'stranger' } }, repository: { full_name: 'org/repo' }, issue: { number: 1853, pull_request: {} } };
  assert.deepEqual(eventDecision(event, 'admin'), { reason: 'not-approved' });
  assert.deepEqual(eventDecision(event, ''), { reason: 'not-approved' });
  event.comment.user.login = 'ADMIN';
  for (const [body, preset, mode] of [['@codjiflo codex', 'sol-xhigh', 'incremental'], ['@codjiflo claude full', 'opus-xhigh', 'full'], ['@codjiflo SOL-MEDIUM', 'sol-medium', 'incremental']]) {
    event.comment.body = body;
    assert.deepEqual(eventDecision(event, 'admin'), { reason: 'approved', request: { preset, mode, repo: 'org/repo', number: 1853, requester: 'ADMIN' } });
    assert.deepEqual(eventDecision({ ...event, action: 'edited' }, 'admin'), { reason: 'not-a-command' });
    assert.deepEqual(eventDecision({ ...event, issue: { number: 1853 } }, 'admin'), { reason: 'not-a-pr' });
  }
  event.comment.body = '@codjiflo codex claude';
  const invalid = eventDecision(event, 'admin');
  assert.equal(invalid.reason, 'invalid-command');
  assert.match(invalid.error.message, /Invalid review command/);
  event.comment.user.login = 'stranger';
  assert.deepEqual(eventDecision(event, 'admin'), { reason: 'not-approved' });
});
test('event authorization uses original comment sender, not rerunner actor', () => {
  const event = { action: 'created', sender: { login: 'admin' }, comment: { body: '@codjiflo-reviewer review', user: { login: 'stranger' } }, repository: { full_name: 'org/repo' }, issue: { number: 1, pull_request: {} } };
  assert.deepEqual(eventDecision(event, 'admin'), { reason: 'not-approved' });
  event.comment.user.login = 'ADMIN';
  assert.equal(eventDecision(event, 'admin').request.requester, 'ADMIN');
  event.comment.body = '@codjiflo-reviewer review CLAUDE';
  assert.deepEqual(eventDecision(event, 'admin'), { reason: 'approved', request: { preset: 'opus-xhigh', mode: 'incremental', repo: 'org/repo', number: 1, requester: 'ADMIN' } });
  assert.deepEqual(eventDecision({ ...event, action: 'edited' }, 'admin'), { reason: 'not-a-command' });
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
  assert.equal(baseline([approved], 'base', 'sol-xhigh').head, sha);
  assert.equal(baseline([approved], 'newbase', 'sol-xhigh'), null);
  assert.equal(baseline([approved], 'base', 'opus-xhigh'), null);
  for (const preset of ['sol-high', 'opus-high', 'codex', 'claude']) {
    assert.equal(baseline([{ ...approved, body: marker(sha, 'base', preset) }], 'base', 'sol-xhigh'), null);
  }
  const pat = { ...approved, user: { type: 'User' } };
  assert.equal(baseline([pat], 'base', 'sol-xhigh').head, sha);
  assert.equal(baseline([approved, { ...pat, state: 'CHANGES_REQUESTED' }], 'base', 'sol-xhigh'), null);
  assert.equal(baseline([approved, { ...approved, state: 'DISMISSED' }], 'base', 'sol-xhigh'), null);
  assert.equal(baseline([{ ...approved, commit_id: 'mismatch' }], 'base', 'sol-xhigh'), null);
});
test('baseline ignores unsupported marker versions without parsing their payloads', () => {
  const approved = { state: 'APPROVED', body: marker(sha, 'base'), commit_id: sha };
  for (const version of ['v1', 'v2', 'v0', 'v4']) {
    const legacy = { ...approved, body: approved.body.replace(':v3 ', `:${version} `) };
    assert.equal(baseline([legacy], 'base', 'sol-xhigh'), null);
    assert.equal(baseline([{ ...legacy, body: `<!-- codjiflo-reviewer:${version} {invalid JSON} -->` }], 'base', 'sol-xhigh'), null);
    assert.equal(baseline([approved, legacy], 'base', 'sol-xhigh').head, sha);
  }
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

test('incomplete analysis and defect-free changes requests fail without a verdict', () => {
  const files = filesFromApi(metadata);
  for (const findings of [[], [finding]]) {
    assert.throws(() => validateResult({
      verdict: 'INCOMPLETE', summary: 'Required docs missing; pwsh.exe unavailable; DNS failed.', findings,
    }, files, 15));
  }
  for (const findings of [[], [{ ...finding, disposition: 'advisory' }]]) {
    assert.throws(() => validateResult({
      verdict: 'REQUEST_CHANGES', summary: 'Review failed before the ten-angle analysis; this is not a defect verdict.', findings,
    }, files, 15), /no blocking defect findings/);
  }
  const unanchorable = { verdict: 'REQUEST_CHANGES', summary: 'Concrete defect found.', findings: [{ ...finding, line: 999 }] };
  assert.deepEqual(validateResult(unanchorable, files, 15), []);
  assert.equal(unanchorable.verdict, 'REQUEST_CHANGES');
  assert.match(unanchorable.summary, /Broken result/);
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

test('missing and truncated API patches preserve advisory approval in the review summary', () => {
  for (const patch of [undefined, '@@ -1,2 +1,2 @@\n-old\n+new', '@@ -1 +1 @@\n-old\n+new']) {
    const files = filesFromApi([{ filename: 'a.js', additions: 2, deletions: 2, patch }]);
    const result = { verdict: 'APPROVE', summary: 'Review complete.', findings: [{ ...finding, disposition: 'advisory' }] };
    assert.deepEqual(validateResult(result, files, 10), []);
    assert.equal(result.verdict, 'APPROVE');
    assert.match(result.summary, /Broken result/);
    assert.match(result.summary, /Fails for zero/);
  }
});
