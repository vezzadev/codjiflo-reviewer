import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseline, outstandingFindings, review, validateResult } from '../src/review.mjs';
import { filesFromApi } from '../src/diff.mjs';
import { GitHub } from '../src/github.mjs';
import { fixture } from './fixture.mjs';

const finding = { path: 'a.js', side: 'RIGHT', start_line: 1, line: 1, priority: 'P1', disposition: 'blocking', title: 'Independent defect', body: 'This independent failure remains reproducible.' };
const entry = (head, overrides = {}) => ({ ...finding, id: randomUUID(), originHead: head, ...overrides });
const marker = (head, base, findings, preset) => `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head, base, preset, findings, kickoffId: 1 })} -->`;
const checkpoint = (head, base, findings, preset) => ({ state: 'CHANGES_REQUESTED', commit_id: head, body: marker(head, base, findings, preset) });
const published = f => f.state.posts.filter(post => post.path.endsWith('/reviews')).at(-1).body;
const ledger = body => JSON.parse(body.split('\n').find(line => line.startsWith('<!-- codjiflo-reviewer:v4 ')).slice('<!-- codjiflo-reviewer:v4 '.length, -' -->'.length));
const scopeDiff = input => input.slice(input.indexOf('Review-scope unified diff follows:\n') + 'Review-scope unified diff follows:\n'.length, input.indexOf('Authoritative current PR file metadata'));

for (const [preset, cap] of [['opus-medium', 10], ['opus-xhigh', 15]]) {
  test(`${preset}: only checkpoints below the original new-findings cap are incremental baselines`, () => {
    const head = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    for (const disposition of ['blocking', 'advisory']) {
      for (const count of [cap - 1, cap, cap + 1]) {
        const findings = Array.from({ length: count }, (_, index) => entry(head, { title: `Finding ${index}`, disposition }));
        const reviews = [{ ...checkpoint(head, base, findings, preset), state: disposition === 'advisory' ? 'APPROVED' : 'CHANGES_REQUESTED' }];
        assert.deepEqual(outstandingFindings(reviews), findings);
        assert.equal(baseline(reviews, base, preset)?.head ?? null, count < cap ? head : null, `${disposition}, count=${count}`);
      }
    }
  });

  test(`${preset}: advisories consume the same new-findings cap as blockers`, () => {
    const files = filesFromApi([{ filename: 'a.js', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]);
    for (const blocking of [0, 1]) {
      const findings = Array.from({ length: cap }, (_, index) => ({ ...finding, title: `Finding ${index}`, disposition: index < blocking ? 'blocking' : 'advisory' }));
      const result = { verdict: blocking ? 'REQUEST_CHANGES' : 'APPROVE', summary: 'Complete.', findings, resolutions: [] };
      assert.equal(validateResult(result, files, cap).length, cap);
      assert.throws(() => validateResult({ ...result, findings: [...findings, { ...finding, disposition: 'advisory', title: 'One over cap' }] }, files, cap));
    }
  });

  test(`${preset}: a saturated full review cannot hide an unchanged unreported blocker on the next revision`, async () => {
    const f = await fixture();
    try {
      const defects = Object.fromEntries(Array.from({ length: cap + 1 }, (_, index) => [`defect-${String(index).padStart(2, '0')}.js`, `export const defect = ${index};\n`]));
      const firstHead = await f.advance(defects);
      const github = new GitHub({ token: 'fixture-token-not-real', url: f.api });
      const scans = [];
      const analyze = async ({ prompt, cwd }) => {
        const diff = scopeDiff(prompt);
        const paths = [...diff.matchAll(/^diff --git a\/(defect-\d+\.js) b\/\1$/gm)].map(match => match[1]);
        const candidates = [];
        for (const path of paths) {
          const source = await readFile(join(cwd, path), 'utf8');
          const match = /^export const defect = (\d+);$/m.exec(source);
          if (match) candidates.push({ ...finding, path, title: `Independent defect ${match[1]}`, body: `Module ${path} independently exposes invalid value ${match[1]}.` });
        }
        scans.push({ prompt, diff, paths, candidates });
        const prior = outstandingFindings(f.state.reviews);
        const findings = candidates.slice(0, cap);
        return {
          verdict: findings.length ? 'REQUEST_CHANGES' : 'APPROVE', summary: 'Inspected every file in the supplied scope.', findings,
          resolutions: await Promise.all(prior.map(async item => ({ id: item.id, status: (await readFile(join(cwd, item.path), 'utf8')).includes('export const defect = ') ? 'unresolved' : 'resolved', reason: 'Checked the current module implementation.' }))),
        };
      };
      const invoke = mode => review({ request: { repo: 'org/repo', number: 1, requester: 'Alice', preset, mode }, github, env: { ...f.env, CODJIFLO_APPROVED_USERS: 'alice' }, output: join(f.temp, 'publication.json'), reviewer: analyze });
      await invoke('full');
      const first = ledger(published(f).body);
      assert.equal(first.findings.length, cap);
      assert.equal(new Set(first.findings.map(item => item.path)).size, cap);
      assert.ok(first.findings.every(item => item.originHead === firstHead));
      assert.equal(scans[0].candidates.length, cap + 1);
      const unreported = Object.keys(defects).find(path => !first.findings.some(item => item.path === path));
      assert.ok(unreported);
      const secondHead = await f.advance(Object.fromEntries(first.findings.map(item => [item.path, 'export const fixed = true;\n'])));
      const delta = await runGit(f, ['diff', '--name-only', firstHead, secondHead]);
      assert.ok(!delta.split('\n').includes(unreported));
      await invoke('incremental');
      const second = published(f);
      assert.equal(second.event, 'REQUEST_CHANGES');
      assert.equal(second.commit_id, secondHead);
      assert.deepEqual(ledger(second.body).findings.map(item => item.path), [unreported]);
      assert.deepEqual(second.comments.map(item => item.path), [unreported]);
      assert.ok(scans[1].paths.includes(unreported));
      assert.ok(scans[1].diff.includes(`+${defects[unreported]}`));
      assert.ok(scans[1].prompt.includes(`git diff ${f.base} ${secondHead}`));
      assert.ok(!scans[1].prompt.includes(`git diff ${firstHead} ${secondHead}`));
      assert.match(second.body, /Scope: \*\*full\*\* \(previous review reached the new-findings cap\)/);
      assert.ok(f.state.requests.some(request => request.path.startsWith('/repos/org/repo/pulls/1/files?')));
    } finally { await f.close(); }
  });
}

async function runGit(f, args) {
  const { runProcess } = await import('../src/runner.mjs');
  return runProcess('git', args, { cwd: f.repo, env: f.env });
}

test('a large old-origin carried ledger stays incremental and is never truncated', async () => {
  const f = await fixture();
  try {
    const prior = Array.from({ length: 24 }, (_, index) => entry(f.base, { title: `Carried ${index}`, path: `unchanged-${index}.js` }));
    f.state.reviews = [checkpoint(f.previous, f.base, prior, 'opus-medium')];
    assert.equal(baseline(f.state.reviews, f.base, 'opus-medium').head, f.previous);
    await f.run({ preset: 'opus-medium', providerEnv: { FIXTURE_RESULT: JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 'All carried evidence retained.', findings: [], resolutions: prior.map(item => ({ id: item.id, status: 'unresolved', reason: 'Still reproducible.' })) }) } });
    assert.deepEqual(ledger(published(f).body).findings, prior);
    assert.deepEqual(published(f).comments, []);
    const input = await readFile(f.capture, 'utf8');
    assert.ok(input.includes(`git diff ${f.previous} ${f.head}`));
    assert.ok(!scopeDiff(input).includes('-old\n'));
    assert.ok(scopeDiff(input).includes('+changed\n'));
  } finally { await f.close(); }
});

test('a CRLF published checkpoint is reused without altering ledger strings or paths', async () => {
  const f = await fixture();
  try {
    const added = { ...finding, path: 'a.js', title: 'Literal \\r remains literal', body: 'Embedded carriage return\r and newline\n and résumé <!-- marker --> remain exact.' };
    await f.run({ providerEnv: { FIXTURE_RESULT: JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 'Initial publication.', findings: [added], resolutions: [] }) } });
    const original = ledger(published(f).body).findings;
    f.state.reviews.at(-1).body = f.state.reviews.at(-1).body.replaceAll('\n', '\r\n');
    assert.deepEqual(outstandingFindings(f.state.reviews), original);
    assert.equal(baseline(f.state.reviews, f.base, 'opus-xhigh').head, f.head);
    const next = await f.advance({ 'a.js': 'new\nchanged CRLF round\n' });
    await f.run({ providerEnv: { FIXTURE_RESULT: JSON.stringify({ verdict: 'REQUEST_CHANGES', summary: 'Reconciled unchanged evidence.', findings: [], resolutions: original.map(item => ({ id: item.id, status: 'unresolved', reason: 'Still reproducible.' })) }) } });
    assert.deepEqual(ledger(published(f).body).findings, original);
    assert.deepEqual(published(f).comments, []);
    const input = await readFile(f.capture, 'utf8');
    assert.ok(input.includes(`git diff ${f.head} ${next}`));
    assert.ok(!scopeDiff(input).includes('-old\n'));
    // A literal escaped CR in a path must not be globally normalized either.
    const unusual = entry(f.head, { path: 'literal\rpath.js', body: added.body });
    const review = checkpoint(f.head, f.base, [unusual], 'opus-xhigh');
    review.body += '\r';
    assert.deepEqual(outstandingFindings([review]), [unusual]);
  } finally { await f.close(); }
});

test('a CR inside a metadata marker remains invalid rather than being normalized into a checkpoint', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const prior = entry(head);
  const valid = checkpoint(head, base, [prior], 'opus-xhigh');
  for (const body of [
    valid.body.replace(':v4 ', ':v\r4 '),
    valid.body.replace('"findings":', '"find\rings":'),
    valid.body.replace(' -->', ' --\r>'),
    `${valid.body}\r\r`,
  ]) {
    const reviews = [valid, { ...valid, body }];
    assert.equal(baseline(reviews, base, 'opus-xhigh'), null);
    assert.deepEqual(outstandingFindings(reviews), []);
  }
});
