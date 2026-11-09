import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/runner.mjs';
import { fixture } from './fixture.mjs';
import { getCheckpointSnapshot, latestCheckpoint, parseCheckpoint } from '../src/checkpoints.mjs';
const { publishReview, reportPublicationFailure } = await import(process.env.CODJIFLO_PUBLICATION_MODULE || '../src/publication.mjs');

const env = { CODJIFLO_APPROVED_USERS: 'alice' };
function setup(event = 'REQUEST_CHANGES') {
  const envelope = { version: 2, analyzedCheckpoint: { fingerprint: null, highestKickoffId: 0 }, request: { repo: 'org/repo', number: 1, requester: 'alice', preset: 'sol-xhigh', mode: 'full' }, head: 'a'.repeat(40), base: 'b'.repeat(40), payload: { commit_id: 'a'.repeat(40), event, body: 'Review\n<!-- codjiflo-publication:12345678-1234-4234-8234-123456789abc -->', comments: [] } };
  const receipt = { id: 42, state: event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', commit_id: envelope.head, body: envelope.payload.body };
  const state = { posts: 0, lists: 0, reviews: [], movement: 'none', events: [] };
  const github = {
    async list() { state.lists++; state.events.push('list'); return state.reviews; },
    async request(path, options) {
      if (options?.method === 'POST') {
        state.posts++; state.events.push('post');
        if (options.body.event === 'COMMENT') Object.assign(receipt, { state: 'COMMENTED', body: options.body.body });
        return receipt;
      }
      state.events.push('pull');
      return { state: state.movement === 'closed' ? 'closed' : 'open', head: { sha: ['head', 'both'].includes(state.movement) ? 'c'.repeat(40) : envelope.head }, base: { sha: ['base', 'both'].includes(state.movement) ? 'd'.repeat(40) : envelope.base } };
    },
  };
  return { envelope, receipt, state, github };
}

test('legacy envelopes and missing or malformed analyzed checkpoints fail before GitHub calls', async t => {
  for (const change of [
    envelope => { envelope.version = 1; },
    envelope => { delete envelope.analyzedCheckpoint; },
    envelope => { envelope.analyzedCheckpoint = null; },
    envelope => { envelope.analyzedCheckpoint = { fingerprint: null }; },
    envelope => { envelope.analyzedCheckpoint.highestKickoffId = -1; },
    envelope => { envelope.analyzedCheckpoint.highestKickoffId = 1.5; },
    envelope => { envelope.analyzedCheckpoint.highestKickoffId = Number.MAX_SAFE_INTEGER + 1; },
    envelope => { envelope.analyzedCheckpoint.fingerprint = 42; },
  ]) await t.test(String(change), async () => {
    const f = setup();
    change(f.envelope);
    await assert.rejects(publishReview({ ...f, env }), /Invalid saved publication/);
    assert.deepEqual(f.state.events, []);
  });
});

test('changed checkpoint identity rejects initial publication and retry without posting a replacement ledger', async t => {
  for (const duringRetry of [false, true]) {
    for (const event of ['APPROVE', 'REQUEST_CHANGES']) for (const change of ['new-checkpoint', 'ledger', 'state', 'removed']) await t.test(`${event}, ${change}, retry=${duringRetry}`, async () => {
      const f = generationSetup(event, 300);
      const prior = newerGeneration('REQUEST_CHANGES', 100).receipt;
      if (change !== 'new-checkpoint') f.state.reviews.push(prior);
      f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
      const saved = structuredClone(f.envelope);
      const mutate = () => {
        if (change === 'new-checkpoint') f.state.reviews.push(prior);
        if (change === 'ledger') prior.body = prior.body.replace('The original failure remains.', 'The failure now affects cancellation.');
        if (change === 'state') prior.state = 'COMMENTED';
        if (change === 'removed') f.state.reviews = [];
      };
      const original = f.github.request;
      f.github.request = async (path, options) => {
        if (!options) return original(path);
        f.state.posts++;
        throw Object.assign(new Error('transient publication failure'), { status: 503 });
      };
      if (!duringRetry) mutate();
      await assert.rejects(publishReview({ ...f, env, delay: async () => mutate() }), /checkpoint changed.*rerun/i);
      assert.equal(f.state.posts, duringRetry ? 1 : 0);
      assert.deepEqual(f.envelope, saved);
    });
  }
});

test('a confirmed same-identity receipt recovers even after the selected checkpoint changes', async () => {
  const f = generationSetup('APPROVE', 100);
  f.state.reviews.push(f.receipt, newerGeneration('REQUEST_CHANGES', 200).receipt);
  assert.equal(await publishReview({ ...f, env }), f.receipt);
  assert.equal(f.state.posts, 0);
});

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
  }
  return value;
}

function withCheckpointValue(receipt, value) {
  return { ...receipt, body: receipt.body.replace(/<!-- codjiflo-reviewer:v4 \{[^\n]+\} -->/, `<!-- codjiflo-reviewer:v4 ${JSON.stringify(value)} -->`) };
}

test('checkpoint fingerprints canonicalize nested metadata keys without hiding ledger or state changes', () => {
  const prior = newerGeneration().receipt;
  const value = parseCheckpoint(prior).value;
  value.findings.push({ ...value.findings[0], id: '12345678-1234-4234-8234-123456789abc', title: 'Second blocker' });
  const original = withCheckpointValue(prior, value);
  const reordered = withCheckpointValue(prior, reverseObjectKeys(value));
  const snapshot = getCheckpointSnapshot([original]);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/, 'artifacts store a SHA-256 digest, not the old ledger');
  assert.deepEqual(getCheckpointSnapshot([reordered]), snapshot);
  assert.notEqual(getCheckpointSnapshot([{ ...original, state: 'COMMENTED' }]).fingerprint, snapshot.fingerprint);
  const changed = structuredClone(value);
  changed.findings[0].body += ' New evidence.';
  assert.notEqual(getCheckpointSnapshot([withCheckpointValue(prior, changed)]).fingerprint, snapshot.fingerprint);
  const arrayReordered = { ...value, findings: [...value.findings].reverse() };
  assert.notEqual(getCheckpointSnapshot([withCheckpointValue(prior, arrayReordered)]).fingerprint, snapshot.fingerprint, 'finding array order remains significant');
});

test('equivalent checkpoint key reordering permits publication for both verdicts', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = generationSetup(event, 300);
    const prior = newerGeneration('REQUEST_CHANGES', 100).receipt;
    f.envelope.analyzedCheckpoint = getCheckpointSnapshot([prior]);
    const saved = structuredClone(f.envelope);
    f.state.reviews = [withCheckpointValue(prior, reverseObjectKeys(parseCheckpoint(prior).value))];
    const receipt = await publishReview({ ...f, env });
    assert.equal(receipt.state, event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED');
    assert.equal(f.state.posts, 1);
    assert.deepEqual(f.envelope, saved);
  });
});

test('null checkpoint high-water marks reject stale artifacts when current higher history disappears', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    for (const duringRetry of [false, true]) {
      for (const movement of ['none', 'head', 'base', 'both']) await t.test(`${event}, retry=${duringRetry}, movement=${movement}`, async () => {
        const f = generationSetup(event, 100);
        const barrier = { state: 'COMMENTED', commit_id: f.envelope.head, body: '<!-- codjiflo-reviewer:v4 {bad JSON} -->' };
        const higherHistory = [newerGeneration('REQUEST_CHANGES', 200).receipt, barrier];
        f.envelope.analyzedCheckpoint = getCheckpointSnapshot(higherHistory);
        assert.deepEqual(f.envelope.analyzedCheckpoint, { fingerprint: null, highestKickoffId: 200 });
        // Recovery preserves causal history even when the selected checkpoint is
        // null. Equal null fingerprints do not make the old ledger safe to post.
        f.envelope = JSON.parse(JSON.stringify(f.envelope));
        const saved = structuredClone(f.envelope);
        f.state.movement = movement;
        if (duringRetry) {
          f.state.reviews = higherHistory;
          const original = f.github.request;
          f.github.request = async (path, options) => {
            if (!options) return original(path);
            f.state.posts++;
            assert.equal(options.body.event, 'COMMENT');
            throw Object.assign(new Error('transient publication failure'), { status: 503 });
          };
        }
        await assert.rejects(publishReview({
          ...f, env, delay: async () => { f.state.reviews = []; },
        }), /checkpoint changed.*rerun/i);
        assert.equal(f.state.posts, duringRetry ? 1 : 0, 'no stale ledger POST after higher history disappears');
        assert.equal(latestCheckpoint(f.state.reviews), null, 'rejection must not create a selected stale ledger');
        assert.deepEqual(f.envelope, saved);
      });
    }
  }
});

test('retained higher generation does not authorize a mismatched checkpoint after current higher history disappears', async t => {
  for (const current of ['lower', 'omitted']) await t.test(current, async () => {
    const f = generationSetup('APPROVE', 150);
    f.envelope.analyzedCheckpoint = getCheckpointSnapshot([newerGeneration('REQUEST_CHANGES', 200).receipt]);
    if (current === 'lower') f.state.reviews.push(newerGeneration('REQUEST_CHANGES', 100).receipt);
    await assert.rejects(publishReview({ ...f, env }), /checkpoint changed.*rerun/i);
    assert.equal(f.state.posts, 0, 'a stale COMMENT could become authoritative without the higher current generation');
  });
});

function generationSetup(event = 'REQUEST_CHANGES', kickoffId = 100) {
  const f = setup(event);
  const findings = event === 'APPROVE' ? [] : [{
    id: '87654321-4321-4321-8321-cba987654321', originHead: f.envelope.head,
    path: 'a.js', side: 'RIGHT', start_line: 1, line: 1, priority: 'P1',
    disposition: 'blocking', title: 'Unresolved blocker', body: 'The original failure remains.',
  }];
  const metadata = { head: f.envelope.head, base: f.envelope.base, preset: 'sol-xhigh', findings, kickoffId };
  f.envelope.payload.body = `Review\n<!-- codjiflo-reviewer:v4 ${JSON.stringify(metadata)} -->\n${f.envelope.payload.body.split('\n').at(-1)}`;
  f.receipt.body = f.envelope.payload.body;
  return f;
}

function newerGeneration(event = 'REQUEST_CHANGES', kickoffId = 200) {
  const newer = generationSetup(event, kickoffId);
  newer.envelope.payload.body = newer.envelope.payload.body.replace('123456789abc', '123456789abd');
  newer.receipt.body = newer.envelope.payload.body;
  newer.receipt.id = 43;
  return newer;
}

async function generationReceipt(event) {
  const f = generationSetup(event);
  f.state.reviews.push(newerGeneration(event === 'APPROVE' ? 'REQUEST_CHANGES' : 'APPROVE').receipt);
  f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
  return publishReview({ ...f, env });
}

test('failed older native verdict recovers as a comment after a newer same-head opposite verdict', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const older = generationSetup(event);
    const newer = newerGeneration(event === 'APPROVE' ? 'REQUEST_CHANGES' : 'APPROVE');
    const saved = structuredClone(older.envelope);
    const posted = [];
    let failOlder = true;
    const github = {
      async list() { return older.state.reviews; },
      async request(path, options) {
        if (!options) return { state: 'open', head: { sha: saved.head }, base: { sha: saved.base } };
        posted.push(structuredClone(options.body));
        if (failOlder) throw Object.assign(new Error('old native publication failed'), { status: 422 });
        const receipt = {
          id: older.state.reviews.length + 50, commit_id: options.body.commit_id,
          state: { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[options.body.event],
          body: options.body.body,
        };
        older.state.reviews.push(receipt);
        return receipt;
      },
    };
    await assert.rejects(publishReview({ envelope: older.envelope, github, env }), /old native publication failed/);
    assert.equal(posted[0].event, event);
    failOlder = false;
    const current = await publishReview({ envelope: newer.envelope, github, env });
    assert.equal(current.state, event === 'APPROVE' ? 'CHANGES_REQUESTED' : 'APPROVED');
    const recovered = await publishReview({ envelope: older.envelope, github, env });
    assert.equal(recovered.state, 'COMMENTED');
    assertPublishedPayload(posted.at(-1), saved.payload, true);
    assert.match(recovered.body, /A newer review generation superseded this review/);
    assert.deepEqual(older.envelope, saved);
    assert.equal(await publishReview({ envelope: older.envelope, github, env }), recovered);
    assert.equal(posted.length, 3, 'recovery retries reuse the same receipt');
    assert.equal(current.state, event === 'APPROVE' ? 'CHANGES_REQUESTED' : 'APPROVED');
  });
});

test('publication retries retain high-water observations but reject when current higher history disappears', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = generationSetup(event);
    const saved = structuredClone(f.envelope);
    const posted = [];
    let delayed = false;
    const barrier = { state: 'COMMENTED', commit_id: f.envelope.head, body: '<!-- codjiflo-reviewer:v4 {bad JSON} -->' };
    f.github.list = async () => delayed && posted.length < 2 ? [newerGeneration().receipt, barrier] : [];
    const original = f.github.request;
    f.github.request = async (path, options) => {
      if (!options) return original(path);
      posted.push(structuredClone(options.body));
      throw Object.assign(new Error('transient publication failure'), { status: 503 });
    };
    // A third COMMENT used to be accepted from the retained high-water mark
    // alone, which could install the old generation as the selected ledger.
    await assert.rejects(publishReview({ ...f, env, delay: async () => { delayed = true; } }), /checkpoint changed.*rerun/i);
    assert.deepEqual(posted.map(payload => payload.event), [event, 'COMMENT']);
    assert.match(posted[1].body, /A newer review generation superseded this review/);
    assert.equal(latestCheckpoint(f.state.reviews), null);
    assert.deepEqual(f.envelope, saved);
  });
});

test('older comments remain safe when a strictly higher current generation remains through retries', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = generationSetup(event);
    const higher = newerGeneration().receipt;
    const barrier = { state: 'COMMENTED', commit_id: f.envelope.head, body: '<!-- codjiflo-reviewer:v4 {bad JSON} -->' };
    f.state.reviews = [higher, barrier];
    f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
    assert.deepEqual(f.envelope.analyzedCheckpoint, { fingerprint: null, highestKickoffId: 200 });
    const saved = structuredClone(f.envelope);
    const original = f.github.request;
    f.github.request = async (path, options) => {
      if (!options) return original(path);
      assert.equal(options.body.event, 'COMMENT');
      if (f.state.posts < 2) {
        f.state.posts++;
        throw Object.assign(new Error('transient publication failure'), { status: 503 });
      }
      return original(path, options);
    };
    const receipt = await publishReview({ ...f, env, delay: async () => {} });
    assert.equal(receipt.state, 'COMMENTED');
    assert.equal(f.state.posts, 3);
    f.state.reviews.push(receipt);
    assert.equal(latestCheckpoint(f.state.reviews), null, 'older feedback must not clear the newer barrier');
    assert.equal(await publishReview({ ...f, env }), receipt, 'confirmed identity still recovers without a POST');
    assert.equal(f.state.posts, 3);
    assert.deepEqual(f.envelope, saved);
  });
});

test('generation withholding notice overflow fails closed without changing the retained envelope', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = generationSetup(event);
    f.state.reviews.push(newerGeneration().receipt);
    f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
    f.envelope.payload.body = 'x'.repeat(65536 - f.envelope.payload.body.length) + f.envelope.payload.body;
    const saved = structuredClone(f.envelope);
    await assert.rejects(publishReview({ ...f, env }), /Review body exceeds GitHub limit/);
    assert.equal(f.state.posts, 0);
    assert.deepEqual(f.envelope, saved);
  });
});

test('generation withholding receipts reconcile across CRLF normalization and ambiguous publication', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const valid = await generationReceipt(event);
    for (const scenario of ['direct', 'recovery', 'ambiguous']) await t.test(`${event}, ${scenario}`, async () => {
      const f = generationSetup(event);
      f.state.reviews.push(newerGeneration().receipt);
      f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
      f.envelope.payload.body = f.envelope.payload.body.replaceAll('\n', '\r\n') + '\r\n';
      const saved = structuredClone(f.envelope);
      const normalized = { ...valid, body: valid.body.replaceAll('\n', '\r\n') + '\r\n \t\r\n' };
      if (scenario === 'recovery') f.state.reviews.push(normalized);
      const original = f.github.request;
      f.github.request = async (path, options) => {
        if (!options) return original(path);
        f.state.posts++;
        assertPublishedPayload(options.body, saved.payload, true);
        assert.match(options.body.body, /A newer review generation superseded this review/);
        if (scenario === 'ambiguous') {
          f.state.reviews.push(normalized);
          throw new TypeError('generation comment response lost after commit');
        }
        return normalized;
      };
      assert.equal(await publishReview({ ...f, env, delay: async () => {} }), normalized);
      assert.equal(f.state.posts, scenario === 'recovery' ? 0 : 1);
      assert.deepEqual(f.envelope, saved);
    });
  }
});

test('both withholding notices require exact text and paragraph structure in direct and recovered receipts', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    for (const reason of ['revision', 'generation']) {
      const valid = reason === 'revision' ? await downgradedReceipt(event) : await generationReceipt(event);
      for (const recovery of [false, true]) {
        for (const change of [
          body => body.replace('withheld:', 'not withheld:'),
          body => body.replace('published as a comment', 'published as a neutral comment'),
          body => body.replace('\n\n', '\n'),
          body => body.replace('\n\n', ' Extra text.\n\n'),
          body => `Quoted notice\n${body}`,
          body => body.replace(event === 'APPROVE' ? '**Approval' : '**Change request', event === 'APPROVE' ? '**Change request' : '**Approval'),
        ]) await t.test(`${event}, ${reason}, recovery=${recovery}, ${change(valid.body).split('\n')[0]}`, async () => {
          const f = reason === 'revision' ? setup(event) : generationSetup(event);
          if (reason === 'revision') f.state.movement = 'head';
          else {
            f.state.reviews.push(newerGeneration().receipt);
            f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
          }
          const invalid = { ...valid, body: change(valid.body) };
          if (recovery) f.state.reviews.push(invalid);
          const original = f.github.request;
          f.github.request = async (path, options) => {
            if (!options) return original(path);
            f.state.posts++;
            return invalid;
          };
          await assert.rejects(publishReview({ ...f, env }));
          assert.equal(f.state.posts, recovery ? 0 : 1);
        });
      }
    }
  }
});

test('direct comments confirm the actual withholding reason while recovery accepts either reason', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    for (const reason of ['revision', 'generation']) await t.test(`${event}, ${reason}`, async () => {
      const f = generationSetup(event);
      const opposite = generationSetup(event);
      if (reason === 'revision') {
        f.state.movement = 'head';
        opposite.state.reviews.push(newerGeneration().receipt);
      } else {
        f.state.reviews.push(newerGeneration().receipt);
        opposite.state.movement = 'head';
      }
      f.envelope.analyzedCheckpoint = getCheckpointSnapshot(f.state.reviews);
      opposite.envelope.analyzedCheckpoint = getCheckpointSnapshot(opposite.state.reviews);
      const receipt = await publishReview({ ...opposite, env });
      const original = f.github.request;
      f.github.request = async (path, options) => {
        if (!options) return original(path);
        f.state.posts++;
        assert.match(options.body.body, reason === 'revision' ? /The pull request head or base changed/ : /A newer review generation superseded this review/);
        return receipt;
      };
      await assert.rejects(publishReview({ ...f, env }), /GitHub did not return a confirmed submitted review/);
      assert.equal(f.state.posts, 1);
      f.state.reviews.push(receipt);
      assert.equal(await publishReview({ ...f, env }), receipt, 'recovery accepts either earlier withheld outcome');
      assert.equal(f.state.posts, 1);
    });
  }
});

test('over-limit retained bodies and withheld notices fail closed without a native POST', async t => {
  for (const scenario of ['ascii', 'utf8', 'withheld-notice']) await t.test(scenario, async () => {
    const f = setup();
    const suffix = '\n<!-- codjiflo-publication:12345678-1234-4234-8234-123456789abc -->';
    f.envelope.payload.body = (scenario === 'utf8' ? '漢'.repeat(24000) : 'x'.repeat(scenario === 'withheld-notice' ? 65536 - suffix.length : 65537)) + suffix;
    if (scenario === 'withheld-notice') f.state.movement = 'head';
    const saved = structuredClone(f.envelope);
    await assert.rejects(publishReview({ ...f, env }), /Review body exceeds GitHub limit/);
    assert.equal(f.state.posts, 0);
    assert.deepEqual(f.envelope, saved);
  });
});

function assertPublishedPayload(actual, saved, downgraded) {
  if (!downgraded) return assert.deepEqual(actual, saved);
  assert.deepEqual({ ...actual, event: saved.event, body: saved.body }, saved);
  assert.equal(actual.event, 'COMMENT');
  const verdict = saved.event === 'APPROVE' ? 'Approval' : 'Change request';
  assert.match(actual.body, new RegExp(`^\\*\\*${verdict} withheld:\\*\\* [^\\r\\n]+\\n\\n`));
  assert.ok(actual.body.endsWith('\n\n' + saved.body), 'original review and publication identity are retained');
}

async function downgradedReceipt(event) {
  const f = setup(event);
  f.state.movement = 'head';
  return publishReview({ ...f, env });
}

test('failure sink redacts client-only publication credentials and provider secrets before truncation', async () => {
  const token = 'fixture-client-token-not-in-env';
  const provider = 'fixture-provider-secret-not-real';
  const posts = [];
  await reportPublicationFailure({
    request: { repo: 'org/repo', number: 1 },
    github: { token, async request(path, options) { posts.push({ path, ...options }); } },
    env: { OPENAI_API_KEY: provider },
    error: new Error(`client=${token} provider=${provider}\n${'x'.repeat(1450)}${token}`),
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/repos/org/repo/issues/1/comments');
  assert.match(posts[0].body.body, /client=\[REDACTED\] provider=\[REDACTED\]/);
  assert.ok(!posts[0].body.body.includes(token));
  assert.ok(!posts[0].body.body.includes(provider));
  assert.ok(!posts[0].body.body.includes('fixture-client-'));
});

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

test('publication safety reads retry transient failures before any POST', async t => {
  for (const operation of ['reconciliation', 'pull']) {
    for (const recovered of [false, true]) await t.test(`${operation}, recovered=${recovered}`, async () => {
      const f = setup();
      const delays = [];
      let reads = 0;
      const failure = Object.assign(new Error('transient safety read'), { status: 503 });
      const original = operation === 'reconciliation' ? f.github.list : f.github.request;
      const read = async (...args) => {
        if (args[1]?.method === 'POST') return original(...args);
        reads++;
        assert.equal(f.state.posts, 0);
        if (!recovered || reads < 3) throw failure;
        return original(...args);
      };
      if (operation === 'reconciliation') f.github.list = read;
      else f.github.request = read;
      const publication = publishReview({ ...f, env, delay: async ms => { delays.push(ms); } });
      if (recovered) assert.equal(await publication, f.receipt);
      else await assert.rejects(publication, error => error === failure);
      assert.equal(reads, 3);
      assert.equal(f.state.posts, recovered ? 1 : 0);
      assert.deepEqual(delays, [1000, 2000]);
    });
  }
});

test('permanent safety read failures are not retried or followed by a POST', async t => {
  for (const operation of ['reconciliation', 'pull']) await t.test(operation, async () => {
    const f = setup();
    let reads = 0;
    const failure = Object.assign(new Error('forbidden safety read'), { status: 403 });
    const read = async () => { reads++; throw failure; };
    if (operation === 'reconciliation') f.github.list = read;
    else f.github.request = read;
    await assert.rejects(publishReview({ ...f, env, delay: async () => assert.fail('permanent failure must not back off') }), error => error === failure);
    assert.equal(reads, 1);
    assert.equal(f.state.posts, 0);
  });
});

test('transient reconciliation after an ambiguous POST retries reads, not the POST', async t => {
  for (const recovered of [false, true]) await t.test(`recovered=${recovered}`, async () => {
    const f = setup();
    const original = new TypeError('POST response lost');
    const lookup = new TypeError('reconciliation connection lost');
    let reads = 0;
    const get = f.github.request;
    f.github.request = async (path, options) => {
      if (!options) return get(path);
      f.state.posts++;
      throw original;
    };
    f.github.list = async () => {
      if (!f.state.posts) return [];
      reads++;
      if (!recovered || reads < 3) throw lookup;
      return [f.receipt];
    };
    const delays = [];
    const publication = publishReview({ ...f, env, delay: async ms => { delays.push(ms); } });
    if (recovered) assert.equal(await publication, f.receipt);
    else await assert.rejects(publication, error => {
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, lookup]);
      return true;
    });
    assert.equal(f.state.posts, 1);
    assert.equal(reads, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });
});

test('failed reconciliation, permanent rejection, closed PR and unconfirmed receipt fail closed', async t => {
  for (const scenario of ['reconciliation', 'permanent', 'closed', 'unconfirmed', 'pending']) await t.test(scenario, async () => {
    const f = setup();
    const get = f.github.request;
    if (scenario === 'closed') f.state.movement = 'closed';
    f.github.request = async (path, options) => {
      if (!options) return get(path);
      f.state.posts++;
      if (scenario === 'unconfirmed') return { id: 42 };
      if (scenario === 'pending') return { ...f.receipt, state: 'PENDING' };
      throw Object.assign(new Error('publication failed'), { status: scenario === 'permanent' ? 422 : 500 });
    };
    if (scenario === 'reconciliation') f.github.list = async () => { if (f.state.posts) throw new Error('cannot reconcile'); return []; };
    await assert.rejects(publishReview({ ...f, env, delay: async () => {} }));
    assert.equal(f.state.posts, scenario === 'closed' ? 0 : 1);
  });
});

test('recovery refuses unauthorized requesters and matching pending reviews', async t => {
  for (const scenario of ['unauthorized', 'pending']) await t.test(scenario, async () => {
    const f = setup();
    if (scenario === 'unauthorized') f.envelope.request.requester = 'mallory';
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

test('post-backoff reconciliation failure or closed PR never permits another POST', async t => {
  for (const scenario of ['reconciliation', 'closed']) await t.test(scenario, async () => {
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
        if (delayed && scenario === 'closed') pull.state = 'closed';
        return pull;
      }
      f.state.posts++;
      throw Object.assign(new Error('transient failure'), { status: 503 });
    };
    await assert.rejects(publishReview({ ...f, env, delay: async () => { delayed = true; } }),
      scenario === 'reconciliation' ? /post-backoff lookup failed/ : /not open; refusing publication/);
    assert.equal(f.state.posts, 1);
  });
});

test('head and base movement downgrade both native verdicts, including after a transient POST', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    for (const movement of ['head', 'base', 'both']) {
      for (const duringRetry of [false, true]) await t.test(`${event}, ${movement}, retry=${duringRetry}`, async () => {
        const f = setup(event);
        f.envelope.payload.comments.push({ path: 'a.js', line: 1, side: 'RIGHT', body: 'Pinned finding.' });
        const saved = structuredClone(f.envelope);
        const move = () => { f.state.movement = movement; };
        if (!duringRetry) move();
        const original = f.github.request;
        const posted = [];
        f.github.request = async (path, options) => {
          if (options?.method === 'POST') {
            posted.push(structuredClone(options.body));
            const downgraded = !duringRetry || f.state.posts > 0;
            assertPublishedPayload(options.body, saved.payload, downgraded);
            if (duringRetry && f.state.posts === 0) {
              f.state.posts++;
              throw new TypeError('response lost before commit');
            }
          }
          return original(path, options);
        };
        const receipt = await publishReview({ ...f, env, delay: async () => move() });
        assert.equal(receipt, f.receipt);
        assert.equal(receipt.state, 'COMMENTED');
        assert.equal(f.state.posts, duringRetry ? 2 : 1);
        assert.equal(posted.length, f.state.posts);
        assert.deepEqual(f.envelope, saved);
      });
    }
  }
});

test('unchanged verdicts post the saved native event without mutating the envelope', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = setup(event);
    const saved = structuredClone(f.envelope);
    const original = f.github.request;
    f.github.request = async (path, options) => {
      if (options?.method === 'POST') assert.equal(options.body, f.envelope.payload);
      return original(path, options);
    };
    assert.equal((await publishReview({ ...f, env })).state, event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED');
    assert.deepEqual(f.envelope, saved);
  });
});

test('ambiguous downgraded POST reconciles both verdicts after later movement and closure', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = setup(event);
    f.state.movement = 'head';
    const saved = structuredClone(f.envelope);
    const original = f.github.request;
    f.github.request = async (path, options) => {
      if (options?.method !== 'POST') return original(path, options);
      const receipt = await original(path, options);
      assert.equal(receipt.state, 'COMMENTED');
      assertPublishedPayload(options.body, saved.payload, true);
      f.state.reviews.push(receipt);
      f.state.movement = 'closed';
      throw new TypeError('response lost after comment committed');
    };
    assert.equal(await publishReview({ ...f, env, delay: async () => {} }), f.receipt);
    // Reconciliation identifies the publication, not today's freshness.
    f.state.movement = 'none';
    assert.equal(await publishReview({ ...f, env }), f.receipt);
    assert.equal(f.state.posts, 1);
    assert.deepEqual(f.envelope, saved);
  });
});

test('both verdicts reject COMMENT receipts without the matching withholding prefix and paragraph structure', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const valid = await downgradedReceipt(event);
    const other = await downgradedReceipt(event === 'APPROVE' ? 'REQUEST_CHANGES' : 'APPROVE');
    for (const recovery of [false, true]) {
      for (const body of [
        setup(event).envelope.payload.body,
        `Unrelated comment\n${setup(event).envelope.payload.body}`,
        valid.body.replace('withheld:', 'not withheld:'),
        other.body,
        `Quoted notice\n${valid.body}`,
        valid.body.replace('\n\n', '\n'),
      ]) await t.test(`${event}, recovery=${recovery}, body=${body}`, async () => {
        const f = setup(event);
        f.state.movement = 'head';
        const invalid = { ...valid, body };
        if (recovery) f.state.reviews.push(invalid);
        const original = f.github.request;
        f.github.request = async (path, options) => {
          if (options?.method !== 'POST') return original(path, options);
          f.state.posts++;
          return invalid;
        };
        await assert.rejects(publishReview({ ...f, env }));
        assert.equal(f.state.posts, recovery ? 0 : 1);
      });
    }
  }
});

test('withheld comment confirmation tolerates CRLF and trailing normalization across publication paths', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const valid = await downgradedReceipt(event);
    for (const scenario of ['direct', 'recovery', 'ambiguous']) await t.test(`${event}, ${scenario}`, async () => {
      const f = setup(event);
      f.state.movement = 'head';
      f.envelope.payload.body = f.envelope.payload.body.replaceAll('\n', '\r\n') + '\r\n';
      const saved = structuredClone(f.envelope);
      const normalized = { ...valid, body: valid.body.replaceAll('\n', '\r\n') + '\r\n \t\r\n' };
      if (scenario === 'recovery') f.state.reviews.push(normalized);
      const original = f.github.request;
      f.github.request = async (path, options) => {
        if (options?.method !== 'POST') return original(path, options);
        f.state.posts++;
        assertPublishedPayload(options.body, saved.payload, true);
        if (scenario === 'ambiguous') {
          f.state.reviews.push(normalized);
          throw new TypeError('response lost after normalized comment committed');
        }
        return normalized;
      };
      assert.equal(await publishReview({ ...f, env, delay: async () => {} }), normalized);
      assert.equal(f.state.posts, scenario === 'recovery' ? 0 : 1);
      assert.deepEqual(f.envelope, saved);
    });
  }
});

test('withheld comment confirmation rejects wrong identity, head, ID and state', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const valid = await downgradedReceipt(event);
    for (const scenario of ['uuid', 'head', 'missing-id', 'zero-id', 'string-id', 'unsafe-id', 'pending', 'approved', 'changes-requested']) {
      // The saved native outcome is valid in recovery, not a direct COMMENT receipt.
      const nativeScenario = event === 'APPROVE' ? 'approved' : 'changes-requested';
      for (const recovery of scenario === nativeScenario ? [false] : [false, true]) await t.test(`${event}, ${scenario}, recovery=${recovery}`, async () => {
        const f = setup(event);
        f.state.movement = 'head';
        const invalid = { ...valid };
        if (scenario === 'uuid') invalid.body = invalid.body.replace('123456789abc', '123456789abd');
        if (scenario === 'head') invalid.commit_id = 'c'.repeat(40);
        if (scenario === 'missing-id') delete invalid.id;
        if (scenario === 'zero-id') invalid.id = 0;
        if (scenario === 'string-id') invalid.id = '42';
        if (scenario === 'unsafe-id') invalid.id = Number.MAX_SAFE_INTEGER + 1;
        if (scenario === 'pending') invalid.state = 'PENDING';
        if (scenario === 'approved') invalid.state = 'APPROVED';
        if (scenario === 'changes-requested') invalid.state = 'CHANGES_REQUESTED';
        if (recovery) f.state.reviews.push(invalid);
        const original = f.github.request;
        f.github.request = async (path, options) => {
          if (options?.method !== 'POST') return original(path, options);
          f.state.posts++;
          return invalid;
        };
        await assert.rejects(publishReview({ ...f, env, delay: async () => {} }));
        assert.equal(f.state.posts, recovery && scenario !== 'uuid' ? 0 : 1);
      });
    }
  }
});

test('direct receipts must confirm the actual posted event for both saved verdicts', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    for (const movement of ['none', 'head']) await t.test(`${event}, ${movement}`, async () => {
      const f = setup(event);
      f.state.movement = movement;
      const original = f.github.request;
      f.github.request = async (path, options) => {
        if (options?.method !== 'POST') return original(path, options);
        f.state.posts++;
        assert.equal(options.body.event, movement === 'head' ? 'COMMENT' : event);
        return { ...f.receipt, state: movement === 'head' ? f.receipt.state : 'COMMENTED', body: options.body.body };
      };
      await assert.rejects(publishReview({ ...f, env, delay: async () => {} }));
      assert.equal(f.state.posts, 1);
    });
  }
});

test('delayed original publication reconciles after a later attempt changes the posted event', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    for (const firstEvent of [event, 'COMMENT']) await t.test(`${event}: ${firstEvent} then ${firstEvent === event ? 'COMMENT' : event}`, async () => {
      const f = setup(event);
      f.state.movement = firstEvent === 'COMMENT' ? 'head' : 'none';
      const saved = structuredClone(f.envelope);
      const original = f.github.request;
      const posted = [];
      let committed;
      f.github.request = async (path, options) => {
        if (options?.method !== 'POST') return original(path, options);
        posted.push(structuredClone(options.body));
        f.state.posts++;
        if (f.state.posts === 1) {
          committed = {
            ...f.receipt,
            state: options.body.event === 'COMMENT' ? 'COMMENTED' : f.receipt.state,
            body: options.body.body,
          };
        } else {
          // Attempt one committed, but only becomes visible after attempt two
          // fails before committing its now-different payload.
          f.state.reviews.push(committed);
        }
        throw new TypeError('response lost');
      };
      assert.equal(await publishReview({
        ...f, env, delay: async () => { f.state.movement = f.state.movement === 'none' ? 'head' : 'none'; },
      }), committed);
      assert.deepEqual(posted.map(payload => payload.event), [firstEvent, firstEvent === event ? 'COMMENT' : event]);
      for (const payload of posted) assertPublishedPayload(payload, saved.payload, payload.event === 'COMMENT');
      assert.equal(f.state.posts, 2);
      assert.deepEqual(f.envelope, saved);
    });
  }
});

test('both withheld verdicts visible only after backoff reconcile before a second POST', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = setup(event);
    f.state.movement = 'base';
    const original = f.github.request;
    f.github.request = async (path, options) => {
      if (options?.method !== 'POST') return original(path, options);
      await original(path, options);
      throw new TypeError('response lost after comment committed');
    };
    const delays = [];
    assert.equal(await publishReview({
      ...f, env, delay: async ms => {
        delays.push(ms);
        f.state.reviews.push(f.receipt);
      },
    }), f.receipt);
    assert.equal(f.receipt.state, 'COMMENTED');
    assert.equal(f.state.posts, 1);
    assert.deepEqual(delays, [1000]);
  });
});

test('previously confirmed native verdicts reconcile after later head/base movement and closure', async t => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) await t.test(event, async () => {
    const f = setup(event);
    f.state.reviews.push(f.receipt);
    f.state.movement = 'closed';
    assert.equal(await publishReview({ ...f, env }), f.receipt);
    assert.equal(f.state.posts, 0);
    assert.deepEqual(f.state.events, ['list']);
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
      env: { ...f.env, GITHUB_EVENT_PATH: 'ignored-during-publication', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_OMP_BIN: '/no-provider-needed' },
    });
    assert.match(recovery, /publication confirmed/);
    assert.equal(f.state.posts.length, posts);
  } finally { await f.close(); }
});

test('publication rejection retains result; CLI recovery downgrades both stale verdicts and reconciles after closure', async t => {
  for (const mode of ['approve', 'findings']) await t.test(mode, async () => {
    const f = await fixture();
    try {
      f.state.publicationStatus = 422;
      await assert.rejects(f.run({ mode }), /Fixture publication rejected/);
      assert.equal(f.state.reviews.length, 0);
      assert.match(f.state.posts.at(-1).body.body, /no successful publication was confirmed/);
      const path = join(f.temp, 'publication.json');
      const retained = await readFile(path, 'utf8');
      const envelope = JSON.parse(retained);
      assert.equal(envelope.payload.event, mode === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES');
      f.state.publicationStatus = undefined;
      const recoveryEnv = { ...f.env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_OMP_BIN: '/no-provider-needed' };
      const recover = () => runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--publish', path], { env: recoveryEnv });
      f.state.movement = 'closed';
      const posts = f.state.posts.filter(post => post.path.endsWith('/reviews')).length;
      await assert.rejects(recover(), /not open; refusing publication/);
      assert.equal(f.state.posts.filter(post => post.path.endsWith('/reviews')).length, posts);
      assert.equal(f.state.reviews.length, 0);
      f.state.movement = 'both';
      await recover();
      assert.equal(f.state.reviews.length, 1);
      assertPublishedPayload(f.state.posts.findLast(post => post.path.endsWith('/reviews')).body, envelope.payload, true);
      assert.equal(f.state.reviews[0].state, 'COMMENTED');
      assert.equal(await readFile(path, 'utf8'), retained);
      f.state.movement = 'closed';
      await recover();
      assert.equal(f.state.reviews.length, 1, 'confirmed publication is reconciled even after closure');
    } finally { await f.close(); }
  });
});

test('default CLI results preserve failed changes request and recover as COMMENT without replacing a newer approval', async () => {
  const f = await fixture();
  try {
    const cli = resolve('bin/codjiflo-reviewer.mjs');
    const run = mode => runProcess(process.execPath, [cli, '--repo', 'org/repo', '--pr', '1', '--requester', 'alice', '--full'], {
      cwd: f.temp,
      env: {
        ...f.env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api,
        CODJIFLO_RESULT_PATH: '', CODJIFLO_APPROVED_USERS: 'alice',
        CODJIFLO_OMP_BIN: join(f.temp, 'fake-cli.mjs'), FIXTURE_MODE: mode, FIXTURE_CAPTURE: f.capture,
      },
    });
    const results = async () => (await readdir(f.temp)).filter(name => /^codjiflo-result-[a-f0-9-]+\.json$/.test(name));
    f.state.publicationStatus = 422;
    await assert.rejects(run('findings'), /Fixture publication rejected/);
    const [first] = await results();
    assert.ok(first, 'failed publication must retain a uniquely named result');
    const retained = await readFile(join(f.temp, first), 'utf8');
    f.state.publicationStatus = undefined;
    const log = await run('approve');
    const paths = await results();
    assert.equal(paths.length, 2);
    const second = paths.find(name => name !== first);
    assert.match(log, new RegExp(`Validated review retained at ${second.replaceAll('.', '\\.')}`));
    assert.equal(await readFile(join(f.temp, first), 'utf8'), retained);
    const earlier = JSON.parse(retained);
    const later = JSON.parse(await readFile(join(f.temp, second), 'utf8'));
    assert.notEqual(earlier.payload.body, later.payload.body);
    for (const [name, envelope] of [[first, earlier], [second, later]]) {
      const identity = /<!-- codjiflo-publication:([^ ]+) -->$/.exec(envelope.payload.body)[1];
      assert.equal(name, `codjiflo-result-${identity}.json`);
    }
    assert.equal(earlier.payload.event, 'REQUEST_CHANGES');
    assert.equal(later.payload.event, 'APPROVE');
    const approval = structuredClone(f.state.reviews[0]);
    assert.equal(approval.state, 'APPROVED');
    f.state.movement = 'head';
    const recover = () => runProcess(process.execPath, [cli, '--publish', join(f.temp, first)], {
      env: { ...f.env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_OMP_BIN: '/no-provider-needed' },
    });
    await recover();
    assert.equal(f.state.reviews.length, 2);
    assert.deepEqual(f.state.reviews[0], approval, 'the newer native approval remains untouched');
    assert.equal(f.state.reviews[1].state, 'COMMENTED');
    assertPublishedPayload(f.state.posts.findLast(post => post.path.endsWith('/reviews')).body, earlier.payload, true);
    assert.equal(await readFile(join(f.temp, first), 'utf8'), retained);
    await recover();
    assert.equal(f.state.reviews.length, 2, 'recovery of the withheld changes request is idempotent');
  } finally { await f.close(); }
});

test('explicit result path remains caller-selected and may overwrite an earlier review', async () => {
  const f = await fixture();
  try {
    const path = join(f.temp, 'operator-result.json');
    f.state.publicationStatus = 422;
    await assert.rejects(f.run({ providerEnv: { CODJIFLO_RESULT_PATH: path } }), /Fixture publication rejected/);
    const earlier = await readFile(path, 'utf8');
    f.state.publicationStatus = undefined;
    await runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--repo', 'org/repo', '--pr', '1', '--requester', 'alice', '--output', path], {
      env: {
        ...f.env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api,
        CODJIFLO_RESULT_PATH: join(f.temp, 'ignored-result.json'), CODJIFLO_APPROVED_USERS: 'alice',
        CODJIFLO_OMP_BIN: join(f.temp, 'fake-cli.mjs'), FIXTURE_MODE: 'approve', FIXTURE_CAPTURE: f.capture,
      },
    });
    assert.notEqual(await readFile(path, 'utf8'), earlier);
    assert.ok(!(await readdir(f.temp)).includes('ignored-result.json'), '--output must take precedence over the environment');
  } finally { await f.close(); }
});
