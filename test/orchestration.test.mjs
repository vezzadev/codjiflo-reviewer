import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture.mjs';

const verdicts = f => f.state.posts.filter(post => post.path.endsWith('/reviews'));

test('real CLI orchestration streams and publishes pinned native ranged changes request', async () => {
  const f = await fixture();
  try {
    const log = await f.run({ mode: 'findings' });
    assert.match(log, /streaming live/);
    assert.equal(verdicts(f).length, 1);
    const result = verdicts(f)[0].body;
    assert.equal(result.event, 'REQUEST_CHANGES');
    assert.equal(result.commit_id, f.head);
    assert.equal(result.comments[0].side, 'LEFT');
    assert.equal(result.comments[1].start_side, 'RIGHT');
    assert.equal(result.comments[1].start_line, 1);
    assert.equal(result.comments[1].line, 2);
    assert.match(result.body, /codjiflo-reviewer:v1/);
  } finally { await f.close(); }
});

test('Codex failures, malformed JSON, stale heads and Claude error results never approve', async t => {
  for (const scenario of ['failure', 'malformed', 'stale', 'error-result']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      f.state.stale = scenario === 'stale';
      await assert.rejects(f.run({ mode: scenario, preset: scenario === 'error-result' ? 'opus-high' : 'sol-high' }));
      assert.equal(verdicts(f).length, 0);
      assert.match(f.state.posts.at(-1).body.body, /failed/);
    } finally { await f.close(); }
  });
});

test('Claude structured stream produces native approval', async () => {
  const f = await fixture();
  try {
    await f.run({ preset: 'opus-medium' });
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('denied and empty allowlists cause no HTTP requests or provider launch', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ approved: '' }));
    await assert.rejects(f.run({ approved: 'bob' }));
    assert.equal(f.state.requests.length, 0);
    await assert.rejects(readFile(f.capture));
  } finally { await f.close(); }
});

test('incremental ancestor approval, explicit full, blockers and changed base choose correct scope', async t => {
  for (const scenario of ['incremental', 'full', 'blockers', 'base-change', 'rebase']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      const prior = scenario === 'rebase' ? 'f'.repeat(40) : f.previous;
      const base = scenario === 'base-change' ? 'c'.repeat(40) : f.base;
      f.state.reviews = [{ user: { type: 'Bot' }, state: scenario === 'blockers' ? 'CHANGES_REQUESTED' : 'APPROVED', commit_id: prior, body: `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head: prior, base })} -->` }];
      await f.run({ full: scenario === 'full' });
      const text = await readFile(f.capture, 'utf8');
      assert.match(text, new RegExp(`Review scope: ${scenario === 'incremental' ? 'incremental' : 'full'}`));
      assert.equal(verdicts(f).length, 1);
    } finally { await f.close(); }
  });
});
