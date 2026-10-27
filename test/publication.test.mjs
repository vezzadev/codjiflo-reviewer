import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/runner.mjs';
import { fixture } from './fixture.mjs';
const { publishReview, reportPublicationFailure } = await import(process.env.CODJIFLO_PUBLICATION_MODULE || '../src/publication.mjs');

const env = { CODJIFLO_APPROVED_USERS: 'alice' };
function setup() {
  const envelope = { version: 1, request: { repo: 'org/repo', number: 1, requester: 'alice', preset: 'sol-xhigh', mode: 'full' }, head: 'a'.repeat(40), base: 'b'.repeat(40), payload: { commit_id: 'a'.repeat(40), event: 'REQUEST_CHANGES', body: 'Review\n<!-- codjiflo-publication:12345678-1234-4234-8234-123456789abc -->', comments: [] } };
  const receipt = { id: 42, state: 'CHANGES_REQUESTED', commit_id: envelope.head, body: envelope.payload.body };
  const state = { posts: 0, lists: 0, reviews: [], stale: false, events: [] };
  const github = {
    async list() { state.lists++; state.events.push('list'); return state.reviews; },
    async request(path, options) {
      if (options?.method === 'POST') { state.posts++; state.events.push('post'); return receipt; }
      state.events.push('pull');
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
  const delays = [];
  const get = f.github.request;
  f.github.request = async (path, options) => {
    if (!options) return get(path);
    f.state.posts++;
    assert.deepEqual(f.state.events.slice(-2), ['list', 'pull']);
    throw Object.assign(new Error('server failure'), { status: 500 });
  };
  await assert.rejects(publishReview({ ...f, env, delay: async ms => { delays.push(ms); } }), /server failure/);
  assert.equal(f.state.posts, 3);
  assert.equal(f.state.lists, 6);
  assert.deepEqual(delays, [1000, 2000]);
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

test('review visible only after retry backoff is reconciled before a second POST', async () => {
  const f = setup();
  const get = f.github.request;
  f.github.request = async (path, options) => {
    if (!options) return get(path);
    f.state.posts++;
    f.state.events.push('post');
    throw Object.assign(new Error('response lost after commit'), { status: 502 });
  };
  const delays = [];
  const result = await publishReview({ ...f, env, delay: async ms => {
    delays.push(ms);
    f.state.events.push('delay');
    f.state.reviews.push(f.receipt);
  } });
  assert.equal(result, f.receipt);
  assert.equal(f.state.posts, 1);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(f.state.events, ['list', 'pull', 'post', 'list', 'delay', 'list']);
});

test('normalization outside the trailing marker does not invalidate a submitted receipt', async t => {
  for (const scenario of ['direct', 'recovery', 'ambiguous']) await t.test(scenario, async () => {
    const f = setup();
    f.envelope.payload.body = `Review\r\n\r\n${f.envelope.payload.body.split('\n')[1]}\r\n`;
    if (scenario === 'recovery') f.state.reviews.push(f.receipt);
    if (scenario === 'ambiguous') {
      const get = f.github.request;
      f.github.request = async (path, options) => {
        if (!options) return get(path);
        f.state.posts++;
        f.state.reviews.push(f.receipt);
        throw new TypeError('response lost');
      };
    }
    assert.equal(await publishReview({ ...f, env, delay: async () => {} }), f.receipt);
    assert.equal(f.state.posts, scenario === 'recovery' ? 0 : 1);
  });
});

test('missing or malformed trailing saved publication markers fail before GitHub calls', async t => {
  for (const body of [
    'Review without an identity',
    '<!-- codjiflo-publication:unique -->',
    '<!-- codjiflo-publication:12345678-1234-4234-1234-123456789abc -->',
    '<!-- codjiflo-publication:12345678-1234-4234-8234-123456789abc',
    `${setup().envelope.payload.body}\nReview continues after the marker`,
    `Quoted ${setup().envelope.payload.body.split('\n')[1]}`,
    `> ${setup().envelope.payload.body.split('\n')[1]}`,
    `${setup().envelope.payload.body}\n<!-- codjiflo-publication:malformed -->`,
  ]) await t.test(body, async () => {
    const f = setup();
    f.envelope.payload.body = body;
    await assert.rejects(publishReview({ ...f, env }), /Invalid saved publication/);
    assert.deepEqual(f.state.events, []);
  });
});

test('publication identity collisions and invalid matching receipts fail closed', async t => {
  for (const scenario of ['head', 'state', 'missing-id', 'string-id', 'zero-id', 'unsafe-id', 'duplicate-review']) await t.test(scenario, async () => {
    const f = setup();
    const receipt = { ...f.receipt };
    if (scenario === 'head') receipt.commit_id = 'c'.repeat(40);
    if (scenario === 'state') receipt.state = 'APPROVED';
    if (scenario === 'missing-id') delete receipt.id;
    if (scenario === 'string-id') receipt.id = '42';
    if (scenario === 'zero-id') receipt.id = 0;
    if (scenario === 'unsafe-id') receipt.id = Number.MAX_SAFE_INTEGER + 1;
    f.state.reviews.push(receipt);
    if (scenario === 'duplicate-review') f.state.reviews.push({ ...receipt, id: 43 });
    await assert.rejects(publishReview({ ...f, env }), /refusing.*publication/);
    assert.equal(f.state.posts, 0);
  });
});

test('a different publication UUID does not prevent a new publication', async () => {
  const f = setup();
  f.state.reviews.push({ ...f.receipt, body: f.receipt.body.replace('123456789abc', '123456789abd') });
  assert.equal(await publishReview({ ...f, env }), f.receipt);
  assert.equal(f.state.posts, 1);
});

test('malformed trailing receipt markers cannot confirm publication', async () => {
  const f = setup();
  f.receipt.body += '\n<!-- codjiflo-publication:malformed -->';
  await assert.rejects(publishReview({ ...f, env }), /GitHub did not return a confirmed submitted review/);
  assert.equal(f.state.posts, 1);
});

test('summary prose and quoted markers do not override the generated trailing identity', async t => {
  for (const scenario of ['direct', 'recovery', 'ambiguous']) await t.test(scenario, async () => {
    const f = setup();
    const marker = f.receipt.body.split('\n')[1];
    // Earlier markers, including standalone examples in a code fence, are prose.
    f.envelope.payload.body = `Explain codjiflo-publication: and quote \`${marker}\`.\n\n\`\`\`html\n${marker}\n\`\`\`\n\n${f.envelope.payload.body}`;
    f.receipt.body = f.envelope.payload.body;
    if (scenario === 'recovery') f.state.reviews.push(f.receipt);
    if (scenario === 'ambiguous') {
      const get = f.github.request;
      f.github.request = async (path, options) => {
        if (!options) return get(path);
        f.state.posts++;
        f.state.reviews.push(f.receipt);
        throw new TypeError('response lost');
      };
    }
    assert.equal(await publishReview({ ...f, env, delay: async () => {} }), f.receipt);
    assert.equal(f.state.posts, scenario === 'recovery' ? 0 : 1);
  });
});

test('ordinary prose mentioning the UUID is not a matching GitHub review', async () => {
  const f = setup();
  const marker = f.receipt.body.split('\n')[1];
  f.state.reviews.push(
    { ...f.receipt, id: 43, body: `Discuss ${marker} in this review.` },
    { ...f.receipt, id: 44, body: `> ${marker}` },
    { ...f.receipt, id: 45, body: `${marker}\nNot a trailing marker.` },
    { ...f.receipt, id: 46, body: `${marker}\n<!-- codjiflo-publication:12345678-1234-4234-8234-123456789abd -->` },
  );
  assert.equal(await publishReview({ ...f, env }), f.receipt);
  assert.equal(f.state.posts, 1);
});

test('failed reconciliation retains the original POST error and both failure diagnostics', async t => {
  for (const afterBackoff of [false, true]) await t.test(`afterBackoff=${afterBackoff}`, async () => {
    const f = setup();
    const original = Object.assign(new Error('Original POST transport failure'), { status: 503 });
    const lookup = new Error('GitHub reconciliation unavailable');
    let delayed = false;
    const get = f.github.request;
    f.github.request = async (path, options) => {
      if (!options) return get(path);
      f.state.posts++;
      throw original;
    };
    f.github.list = async () => {
      if (f.state.posts && (!afterBackoff || delayed)) throw lookup;
      return [];
    };
    let failure;
    await assert.rejects(publishReview({ ...f, env, delay: async () => { delayed = true; } }), error => {
      failure = error;
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, lookup]);
      assert.match(error.message, /Original POST transport failure/);
      assert.match(error.message, /GitHub reconciliation unavailable/);
      return true;
    });
    assert.equal(f.state.posts, 1);
    let comment;
    await reportPublicationFailure({
      request: f.envelope.request, env, error: failure,
      github: { async request(path, options) { comment = options.body.body; } },
    });
    assert.match(comment, /Original POST transport failure/);
    assert.match(comment, /GitHub reconciliation unavailable/);
  });
});

test('post-backoff reconciliation failure or changed PR never permits another POST', async t => {
  for (const scenario of ['reconciliation', 'head', 'base', 'closed']) await t.test(scenario, async () => {
    const f = setup();
    let delayed = false;
    const get = f.github.request;
    const list = f.github.list;
    f.github.list = async () => {
      if (delayed && scenario === 'reconciliation') throw new Error('post-backoff lookup failed');
      return list();
    };
    f.github.request = async (path, options) => {
      if (!options) {
        const pull = await get(path);
        if (delayed && scenario === 'head') pull.head.sha = 'c'.repeat(40);
        if (delayed && scenario === 'base') pull.base.sha = 'c'.repeat(40);
        if (delayed && scenario === 'closed') pull.state = 'closed';
        return pull;
      }
      f.state.posts++;
      throw Object.assign(new Error('transient failure'), { status: 503 });
    };
    await assert.rejects(publishReview({ ...f, env, delay: async () => { delayed = true; } }),
      scenario === 'reconciliation' ? /post-backoff lookup failed/ : /refusing stale verdict/);
    assert.equal(f.state.posts, 1);
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
