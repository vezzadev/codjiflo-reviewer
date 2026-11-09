import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseline, outstandingFindings, validateResult } from '../src/review.mjs';
import { filesFromApi } from '../src/diff.mjs';
import { MAX_INLINE_INPUT, MAX_EVIDENCE_READ_BYTES } from '../src/input-budget.mjs';
import { runProcess } from '../src/runner.mjs';
import { fixture } from './fixture.mjs';

const finding = { path: 'old-deleted.js', side: 'LEFT', start_line: 400, line: 402, priority: 'P1', disposition: 'blocking', title: 'Original blocker', body: 'The original failure remains reproducible.' };
const entry = (head, overrides = {}) => ({ ...finding, id: randomUUID(), originHead: head, ...overrides });
const marker = (head, base, findings, preset = 'sol-xhigh') => `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head, base, preset, findings })} -->`;
const priorReview = (f, findings, overrides = {}) => ({ state: 'CHANGES_REQUESTED', commit_id: f.previous, body: marker(f.previous, f.base, findings), ...overrides });
const posts = f => f.state.posts.filter(post => post.path.endsWith('/reviews'));
const ledger = body => JSON.parse(/^<!-- codjiflo-reviewer:v4 (\{[^\n]+\}) -->$/.exec(body.split('\n').filter(line => line.startsWith('<!-- codjiflo-reviewer:v4 ')).at(-1))[1]);
const resolution = (finding, status = 'unresolved', reason = 'The original failure still occurs.') => ({ id: finding.id, status, reason });
const result = (resolutions, verdict = 'REQUEST_CHANGES', findings = []) => ({ verdict, summary: 'Review completed.', findings, resolutions });
const run = (f, output, options = {}) => f.run({ ...options, providerEnv: { FIXTURE_RESULT: JSON.stringify(output) } });

test('changes-requested checkpoints support partial resolution across several real Git rounds', async () => {
  const f = await fixture();
  try {
    const first = entry(f.previous);
    const second = entry(f.previous, { title: 'Second original blocker' });
    f.state.reviews = [priorReview(f, [first, second])];
    await run(f, result([resolution(first, 'resolved', 'The new guard fixes the zero case.'), resolution(second)]));
    const partial = posts(f).at(-1).body;
    assert.match(partial.body, /Scope: \*\*incremental\*\*/);
    assert.equal(partial.event, 'REQUEST_CHANGES');
    assert.deepEqual(partial.comments, []);
    assert.deepEqual(ledger(partial.body).findings, [second]);
    for (const detail of [second.id, second.originHead, second.path, second.title, second.body, 'LEFT 400-402', 'The original failure still occurs.']) assert.ok(partial.body.includes(detail), detail);
    assert.ok(!partial.body.includes(first.id));
    const newHead = await f.advance({ 'a.js': 'new\nchanged again\n' });
    await run(f, result([resolution(second, 'resolved', 'The second failure is now fixed.')], 'APPROVE'));
    const complete = posts(f).at(-1).body;
    assert.equal(complete.commit_id, newHead);
    assert.equal(complete.event, 'APPROVE');
    assert.match(complete.body, /Scope: \*\*incremental\*\*/);
    assert.deepEqual(ledger(complete.body).findings, []);
  } finally { await f.close(); }
});

test('marker-looking source text and comment terminators roundtrip unchanged through several ledgers', async () => {
  const f = await fixture();
  try {
    const sourceText = 'Parser mishandles <!-- codjiflo-reviewer: in source and literal --> terminators.';
    const added = { ...finding, title: 'Handle <!-- codjiflo-reviewer: --> safely', body: sourceText };
    const output = result([], 'REQUEST_CHANGES', [added]);
    output.summary = 'Source contains `<!-- codjiflo-reviewer:v3 {example} -->`; this is not metadata.';
    await run(f, output);
    const first = ledger(posts(f).at(-1).body.body).findings;
    const metadata = posts(f).at(-1).body.body.split('\n').filter(line => line.startsWith('<!-- codjiflo-reviewer:v4 ')).at(-1);
    const encoded = metadata.slice('<!-- codjiflo-reviewer:v4 '.length, -' -->'.length);
    assert.ok(!encoded.includes('<'));
    assert.ok(!encoded.includes('-->'));
    assert.deepEqual(first.map(({ id, originHead, ...original }) => original), [added]);
    assert.deepEqual(outstandingFindings(f.state.reviews), first);
    const example = '<!-- codjiflo-reviewer:v3 {example} -->';
    f.state.reviews.at(-1).body = example + '\n' + f.state.reviews.at(-1).body;
    assert.deepEqual(outstandingFindings(f.state.reviews), first);
    await f.advance({ 'a.js': 'new\nchanged marker round\n' });
    await run(f, result(first.map(item => resolution(item))));
    const published = posts(f).at(-1).body;
    assert.match(published.body, /Scope: \*\*incremental\*\*/);
    assert.ok(published.body.includes(sourceText));
    assert.deepEqual(published.comments, []);
    assert.deepEqual(ledger(published.body).findings, first);
    assert.deepEqual(outstandingFindings(f.state.reviews), first);
  } finally { await f.close(); }
});

test('host assigns fresh UUIDs and origins to every new finding while retaining original ledger entries', async () => {
  const f = await fixture();
  try {
    const old = entry(f.previous);
    f.state.reviews = [priorReview(f, [old])];
    const added = { ...finding, path: 'a.js', side: 'RIGHT', start_line: 1, line: 1, title: 'New defect' };
    await run(f, result([resolution(old)], 'REQUEST_CHANGES', [added]));
    const published = posts(f).at(-1).body;
    const findings = ledger(published.body).findings;
    assert.deepEqual(findings[0], old);
    assert.deepEqual(findings[1], { ...added, id: findings[1].id, originHead: f.head });
    assert.match(findings[1].id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    assert.notEqual(findings[1].id, old.id);
    assert.equal(published.comments.length, 1);
    assert.equal(published.comments[0].path, 'a.js');
  } finally { await f.close(); }
});

test('resolution coverage is exact and unresolved blockers cannot be omitted or downgraded', () => {
  const prior = entry('a'.repeat(40));
  const good = resolution(prior);
  for (const resolutions of [undefined, [], [good, good], [{ ...good, id: randomUUID() }], [{ ...good, reason: '' }], [{ ...good, reason: '  ' }], [{ ...good, status: 'ignored' }], [{ ...good, disposition: 'advisory' }]]) {
    assert.throws(() => validateResult(result(resolutions), new Map(), 15, [prior]));
  }
  assert.throws(() => validateResult(result([good], 'APPROVE'), new Map(), 15, [prior]), /blocking/);
  assert.deepEqual(validateResult(result([good]), new Map(), 15, [prior]), []);
  assert.deepEqual(validateResult(result([resolution(prior, 'resolved')], 'APPROVE'), new Map(), 15, [prior]), []);
  assert.throws(() => validateResult(result([resolution(prior, 'resolved')]), new Map(), 15, [prior]), /no blocking/);
  assert.throws(() => validateResult(result([good]), new Map(), 15), /resolutions/);
});

test('invalid reconciliation fails before native publication', async t => {
  for (const scenario of ['missing', 'duplicate', 'unknown', 'approval']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      const old = entry(f.previous);
      f.state.reviews = [priorReview(f, [old])];
      const resolutions = scenario === 'missing' ? [] : scenario === 'duplicate' ? [resolution(old), resolution(old)] : scenario === 'unknown' ? [resolution({ id: randomUUID() })] : [resolution(old)];
      await assert.rejects(run(f, result(resolutions, scenario === 'approval' ? 'APPROVE' : 'REQUEST_CHANGES')));
      assert.equal(posts(f).length, 0);
    } finally { await f.close(); }
  });
});

test('full scans retain the latest valid outstanding ledger across checkpoint incompatibilities', async t => {
  for (const scenario of ['explicit-full', 'base', 'preset', 'same-head', 'history', 'instructions', 'superseded', 'dismissed']) await t.test(scenario, async () => {
    const f = await fixture(scenario === 'instructions' ? { headPrompt: 'New review instructions.' } : {});
    try {
      const old = entry(f.previous);
      const head = scenario === 'same-head' ? f.head : scenario === 'history' ? 'f'.repeat(40) : f.previous;
      const base = scenario === 'base' ? 'c'.repeat(40) : f.base;
      const state = scenario === 'superseded' ? 'COMMENTED' : scenario === 'dismissed' ? 'DISMISSED' : 'CHANGES_REQUESTED';
      f.state.reviews = [priorReview(f, [old], { state, commit_id: head, body: marker(head, base, [old]) })];
      await run(f, result([resolution(old)]), { full: scenario === 'explicit-full', preset: scenario === 'preset' ? 'opus-xhigh' : 'sol-xhigh' });
      const published = posts(f).at(-1).body;
      assert.match(published.body, /Scope: \*\*full\*\*/);
      assert.equal(published.event, 'REQUEST_CHANGES');
      assert.deepEqual(published.comments, []);
      assert.deepEqual(ledger(published.body).findings, [old]);
      assert.ok((await readFile(f.capture, 'utf8')).includes(old.id));
    } finally { await f.close(); }
  });
});

test('newer legacy and malformed markers force a full transition scan instead of reviving an older ledger', async t => {
  for (const scenario of ['v3', 'invalid', 'commit-mismatch', 'duplicate-id']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      const old = entry(f.previous);
      const latest = priorReview(f, [old]);
      if (scenario === 'v3') latest.body = latest.body.replace(':v4 ', ':v3 ');
      if (scenario === 'invalid') latest.body = '<!-- codjiflo-reviewer:v4 {bad JSON} -->';
      if (scenario === 'commit-mismatch') latest.commit_id = f.head;
      if (scenario === 'duplicate-id') latest.body = marker(f.previous, f.base, [old, old]);
      f.state.reviews = [priorReview(f, [old]), latest];
      assert.equal(baseline(f.state.reviews, f.base, 'sol-xhigh'), null);
      assert.deepEqual(outstandingFindings(f.state.reviews), []);
      await run(f, result([], 'APPROVE'));
      assert.match(posts(f).at(-1).body.body, /Scope: \*\*full\*\*/);
      assert.deepEqual(ledger(posts(f).at(-1).body.body).findings, []);
    } finally { await f.close(); }
  });
});

test('malformed ledger fields cannot coerce metadata or revive an earlier valid ledger', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const old = entry(head);
  const valid = { state: 'CHANGES_REQUESTED', commit_id: head, body: marker(head, base, [old]) };
  const payload = { head, base, preset: 'sol-xhigh', findings: [old] };
  const invalid = [
    { ...payload, head: [head] },
    { ...payload, base: [base] },
    { ...payload, preset: ['sol-xhigh'] },
    { ...payload, findings: [{ ...old, id: [old.id] }] },
    { ...payload, findings: [{ ...old, originHead: [head] }] },
    { ...payload, findings: [{ ...old, id: 'not-a-uuid' }] },
    { ...payload, findings: [{ ...old, line: 1 }] },
    { ...payload, findings: [{ ...old, unexpected: true }] },
    { ...payload, findings: [{ ...old, disposition: 'resolved' }] },
  ];
  for (const value of invalid) {
    const latest = { ...valid, body: `<!-- codjiflo-reviewer:v4 ${JSON.stringify(value)} -->` };
    assert.equal(baseline([valid, latest], base, 'sol-xhigh'), null);
    assert.deepEqual(outstandingFindings([valid, latest]), []);
  }
  for (const latest of [
    { ...valid, state: 'APPROVED' },
    { ...valid, body: marker(head, base, []) },
  ]) {
    assert.equal(baseline([valid, latest], base, 'sol-xhigh'), null);
    assert.deepEqual(outstandingFindings([valid, latest]), []);
  }
});

test('an oversized carried ledger fails closed instead of truncating original evidence', async () => {
  const f = await fixture();
  try {
    const old = entry(f.previous, { body: 'Original blocker evidence. '.repeat(3000) });
    f.state.reviews = [priorReview(f, [old])];
    await assert.rejects(run(f, result([resolution(old)])), /Review body exceeds GitHub limit/);
    assert.equal(posts(f).length, 0);
    assert.deepEqual(outstandingFindings(f.state.reviews), [old]);
  } finally { await f.close(); }
});

test('carried findings do not consume the cap for new findings', () => {
  const prior = Array.from({ length: 24 }, () => entry('a'.repeat(40)));
  const files = filesFromApi([{ filename: 'a.js', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]);
  for (const cap of [10, 15]) {
    const added = Array.from({ length: cap }, (_, index) => ({ ...finding, path: 'a.js', side: 'RIGHT', start_line: 1, line: 1, title: `New finding ${index}` }));
    assert.equal(validateResult(result(prior.map(item => resolution(item)), 'REQUEST_CHANGES', added), files, cap, prior).length, cap);
    assert.throws(() => validateResult(result(prior.map(item => resolution(item)), 'REQUEST_CHANGES', [...added, added[0]]), files, cap, prior));
  }
});

test('publication retains a carried set larger than the new-findings cap without stale inline reposts', async () => {
  const f = await fixture();
  try {
    const prior = Array.from({ length: 24 }, (_, index) => entry(f.previous, { title: `Outstanding blocker ${index}` }));
    f.state.reviews = [priorReview(f, prior)];
    const added = Array.from({ length: 10 }, (_, index) => ({ ...finding, path: 'a.js', side: 'RIGHT', start_line: 1, line: 1, title: `New blocker ${index}` }));
    await run(f, result(prior.map(item => resolution(item)), 'REQUEST_CHANGES', added), { preset: 'sol-medium' });
    const published = posts(f).at(-1).body;
    assert.equal(published.event, 'REQUEST_CHANGES');
    assert.equal(published.comments.length, 10);
    assert.deepEqual(ledger(published.body).findings.slice(0, prior.length), prior);
    assert.equal(ledger(published.body).findings.length, 34);
    assert.ok(!f.state.requests.some(request => request.path.includes('threads') || request.path.includes('/comments/')));
  } finally { await f.close(); }
});

test('large prior ledgers are staged losslessly and accessible through bounded UTF-8 evidence reads', async () => {
  const f = await fixture();
  try {
    const excerpt = 'Prior résumé evidence 漢🙂\n';
    const old = entry(f.previous, { body: excerpt.repeat(Math.ceil(MAX_INLINE_INPUT / excerpt.length) + 100) + 'END-OF-PRIOR-EVIDENCE' });
    f.state.reviews = [priorReview(f, [old])];
    await run(f, result([resolution(old, 'resolved', 'All original evidence has been checked and corrected.')], 'APPROVE'));
    const input = await readFile(f.capture, 'utf8');
    assert.ok(input.length < MAX_INLINE_INPUT);
    assert.ok(!input.includes(old.body));
    const manifest = JSON.parse(input.split('\n').find(line => line.startsWith('Navigable review evidence manifest: ')).slice('Navigable review evidence manifest: '.length));
    assert.equal(manifest.priorFindingCount, 1);
    const directory = f.capture + '.evidence';
    const bytes = await readFile(join(directory, 'prior-findings.json'));
    assert.equal(manifest.priorFindingBytes, bytes.length);
    assert.deepEqual(JSON.parse(bytes), [old]);
    let offset = 0;
    let reconstructed = '';
    while (offset < bytes.length) {
      const output = await runProcess(process.execPath, [join(directory, 'read-evidence.mjs'), 'prior-findings.json', String(offset), String(MAX_EVIDENCE_READ_BYTES)]);
      const newline = output.indexOf('\n');
      const header = JSON.parse(output.slice(0, newline));
      const text = output.slice(newline + 1);
      assert.ok(Buffer.byteLength(text) <= MAX_EVIDENCE_READ_BYTES);
      assert.ok(header.next > offset);
      reconstructed += text;
      offset = header.next;
    }
    assert.deepEqual(JSON.parse(reconstructed), [old]);
    assert.ok(reconstructed.includes('END-OF-PRIOR-EVIDENCE'));
  } finally { await f.close(); }
});
