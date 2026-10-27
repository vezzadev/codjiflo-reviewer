import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publishReview } from '../src/publication.mjs';
import { runProcess } from '../src/runner.mjs';
import { fixture } from './fixture.mjs';

const env = { CODJIFLO_APPROVED_USERS: 'alice' };
function setup() {
  const envelope = { version: 1, request: { repo: 'org/repo', number: 1, requester: 'alice', preset: 'sol-xhigh', mode: 'full' }, head: 'a'.repeat(40), base: 'b'.repeat(40), payload: { commit_id: 'a'.repeat(40), event: 'REQUEST_CHANGES', body: 'Review\n<!-- codjiflo-publication:unique -->', comments: [] } };
  const receipt = { id: 42, state: 'CHANGES_REQUESTED', commit_id: envelope.head, body: envelope.payload.body };
  const state = { posts: 0, lists: 0, reviews: [], stale: false };
  const github = {
    async list() { state.lists++; return state.reviews; },
    async request(path, options) {
      if (options?.method === 'POST') { state.posts++; return receipt; }
      return { state: 'open', head: { sha: state.stale ? 'c'.repeat(40) : envelope.head }, base: { sha: envelope.base } };
    },
  };
  return { envelope, receipt, state, github };
}

test('ambiguous committed POST is reconciled without creating duplicate review', async () => {
  const f = setup();
  const get = f.github.request;
  f.github.request = async (path, options) => {
    if (!options) return get(path);
    f.state.posts++;
    f.state.reviews.push(f.receipt);
    throw Object.assign(new Error('HTTP500 after commit'), { status: 500 });
  };
  assert.equal(await publishReview({ ...f, env, delay: async () => {} }), f.receipt);
  assert.equal(f.state.posts, 1);
  assert.equal(await publishReview({ ...f, env }), f.receipt);
  assert.equal(f.state.posts, 1);
});

test('transient publication failures retry only after reconciliation, bounded to three attempts', async () => {
  const f = setup();
  const get = f.github.request;
  f.github.request = async (path, options) => {
    if (!options) return get(path);
    f.state.posts++;
    assert.equal(f.state.lists, f.state.posts);
    throw Object.assign(new Error('server failure'), { status: 500 });
  };
  await assert.rejects(publishReview({ ...f, env, delay: async () => {} }), /server failure/);
  assert.equal(f.state.posts, 3);
});

test('failed reconciliation, permanent rejection, stale head and unconfirmed receipt fail closed', async t => {
  for (const scenario of ['reconciliation', 'permanent', 'stale', 'unconfirmed', 'pending']) await t.test(scenario, async () => {
    const f = setup();
    const get = f.github.request;
    if (scenario === 'stale') f.state.stale = true;
    f.github.request = async (path, options) => {
      if (!options) return get(path);
      f.state.posts++;
      if (scenario === 'unconfirmed') return { id: 42 };
      if (scenario === 'pending') return { ...f.receipt, state: 'PENDING' };
      throw Object.assign(new Error('publication failed'), { status: scenario === 'permanent' ? 422 : 500 });
    };
    if (scenario === 'reconciliation') f.github.list = async () => { if (f.state.posts) throw new Error('cannot reconcile'); return []; };
    await assert.rejects(publishReview({ ...f, env, delay: async () => {} }));
    assert.equal(f.state.posts, scenario === 'stale' ? 0 : 1);
  });
});

test('recovery refuses unauthorized requesters, changed bases and matching pending reviews', async t => {
  for (const scenario of ['unauthorized', 'base', 'pending']) await t.test(scenario, async () => {
    const f = setup();
    if (scenario === 'unauthorized') f.envelope.request.requester = 'mallory';
    if (scenario === 'base') f.github.request = async () => ({ state: 'open', head: { sha: f.envelope.head }, base: { sha: 'c'.repeat(40) } });
    if (scenario === 'pending') f.state.reviews.push({ ...f.receipt, state: 'PENDING' });
    await assert.rejects(publishReview({ ...f, env }));
    assert.equal(f.state.posts, 0);
  });
});

test('real CLI retains validated payload and publication-only recovery does not run a provider or duplicate review', async () => {
  const f = await fixture();
  try {
    const log = await f.run({ mode: 'findings' });
    assert.match(log, /publication confirmed:.*pullrequestreview-/);
    const path = join(f.temp, 'publication.json');
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(envelope.head, f.head);
    assert.equal(envelope.payload.event, 'REQUEST_CHANGES');
    assert.equal(envelope.payload.comments.length, 2);
    const posts = f.state.posts.length;
    const recovery = await runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--publish', path], {
      env: { ...f.env, GITHUB_EVENT_PATH: 'ignored-during-publication', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_CODEX_BIN: '/no-provider-needed' },
    });
    assert.match(recovery, /publication confirmed/);
    assert.equal(f.state.posts.length, posts);
  } finally { await f.close(); }
});

test('publication rejection retains result, reports failure and exits nonzero; later recovery publishes exact payload', async () => {
  const f = await fixture();
  try {
    f.state.publicationStatus = 422;
    await assert.rejects(f.run({ mode: 'findings' }), /Fixture publication rejected/);
    assert.equal(f.state.reviews.length, 0);
    assert.match(f.state.posts.at(-1).body.body, /no successful publication was confirmed/);
    const path = join(f.temp, 'publication.json');
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(envelope.payload.event, 'REQUEST_CHANGES');
    f.state.publicationStatus = undefined;
    const recoveryEnv = { ...f.env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_CODEX_BIN: '/no-provider-needed' };
    f.state.stale = true;
    await assert.rejects(runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--publish', path], { env: recoveryEnv }), /refusing stale verdict/);
    assert.equal(f.state.reviews.length, 0);
    f.state.stale = false;
    await runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--publish', path], {
      env: recoveryEnv,
    });
    assert.equal(f.state.reviews.length, 1);
    assert.deepEqual(f.state.posts.findLast(post => post.path.endsWith('/reviews')).body, envelope.payload);
  } finally { await f.close(); }
});
