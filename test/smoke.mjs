import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/runner.mjs';
import { fixture } from './fixture.mjs';

// No remote writes, credentials or real provider account required. This launches
// the actual entry point, git checkout/fetch, native-fetch HTTP client and OMP adapter.
for (const [preset, canonical] of [['codex', 'sol-xhigh'], ['claude', 'opus-xhigh']]) {
 for (const headPrompt of [undefined, 'Review café parsing and résumé handling.\nCheck cancellation paths.', '']) {
  const f = await fixture({ headPrompt });
  try {
    const log = await f.run({ preset, mode: 'findings' });
    process.stdout.write(log);
    const review = f.state.posts.find(post => post.path.endsWith('/reviews'))?.body;
    assert.equal(review?.event, 'REQUEST_CHANGES');
    assert.equal(review.commit_id, f.head);
    assert.equal(review.comments[0].side, 'LEFT');
    assert.equal(review.comments[1].start_line, 1);
    assert.equal(review.comments[1].line, 2);
    assert.ok(review.body.startsWith(`## Codjiflo Reviewer — ${canonical}\n`));
    assert.ok(review.body.includes(`"preset":"${canonical}"`));
    assert.ok(f.state.posts[0].body.body.includes(`starting **${canonical}**`));
    const captured = await readFile(f.capture, 'utf8');
    assert.equal(await readFile(f.capture + '.stdin', 'utf8'), captured);
    if (headPrompt === undefined) {
      assert.ok(!captured.includes('Repository review instructions'));
      assert.match(captured, /Apply this adapted e-code-review xhigh recipe/);
      assert.match(captured, /Cap final findings at 15 most severe/);
    } else {
      const section = captured.slice(captured.indexOf('Repository review instructions'), captured.indexOf('Review-scope unified diff follows:'));
      assert.ok(section.includes(`--- BEGIN REPOSITORY REVIEW INSTRUCTIONS ---\n${headPrompt}\n--- END REPOSITORY REVIEW INSTRUCTIONS ---`));
      assert.match(section, /replacing the default methodology/);
      assert.ok(!captured.includes('e-code-review'));
      assert.ok(!captured.includes('Cap final findings'));
    }
    assert.match(captured, /final_review/);
    assert.match(captured, /All native comment locations must use the authoritative CURRENT PR API patches/);
    console.log(`PASS ${preset} (${headPrompt === undefined ? 'default' : headPrompt === '' ? 'empty replacement' : 'custom UTF-8 replacement'}): real orchestration, kickoff, pinned native review and LEFT/RIGHT ranges`);
  } finally { await f.close(); }
 }
}
for (const mode of ['approve', 'findings']) {
  for (const scenario of ['unchanged', 'head', 'base', 'both', 'closed', 'snapshot']) {
    const f = await fixture();
    try {
      f.state.moveAtRead = scenario === 'snapshot' ? 2 : 3;
      f.state.stale = ['head', 'both', 'snapshot'].includes(scenario);
      f.state.movedBase = ['base', 'both'].includes(scenario);
      f.state.closed = scenario === 'closed';
      if (!['closed', 'snapshot'].includes(scenario)) {
        await f.run({ mode });
        const review = f.state.posts.find(post => post.path.endsWith('/reviews'))?.body;
        const downgraded = mode === 'approve' && scenario !== 'unchanged';
        assert.equal(review.event, downgraded ? 'COMMENT' : mode === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES');
        assert.equal(review.commit_id, f.head);
        assert.ok(review.body.includes(`Reviewed head: \`${f.head}\`\nReviewed base: \`${f.base}\``));
        const retained = JSON.parse(await readFile(`${f.temp}/publication.json`, 'utf8'));
        assert.equal(retained.payload.event, mode === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES');
        assert.deepEqual(review.comments, retained.payload.comments);
        if (downgraded) assert.ok(review.body.endsWith(retained.payload.body));
        else assert.deepEqual(review, retained.payload);
        assert.equal(f.state.reviews[0].state, downgraded ? 'COMMENTED' : mode === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED');
      } else {
        await assert.rejects(f.run({ mode }), scenario === 'closed' ? /not open; refusing publication/ : /changed while collecting file metadata/);
        assert.equal(f.state.posts.some(post => post.path.endsWith('/reviews')), false);
        if (scenario === 'snapshot') await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
      }
      console.log(`PASS ${mode}, ${scenario}: approval freshness and pinned publication safety`);
    } finally { await f.close(); }
  }
}

for (const mode of ['approve', 'findings']) {
  const f = await fixture();
  try {
    f.state.publicationStatus = 422;
    await assert.rejects(f.run({ mode }), /Fixture publication rejected/);
    const path = join(f.temp, 'publication.json');
    const saved = await readFile(path, 'utf8');
    const envelope = JSON.parse(saved);
    f.state.publicationStatus = undefined;
    f.state.stale = true;
    f.state.movedBase = true;
    const recover = () => runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--publish', path], {
      env: {
        ...f.env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: f.api,
        CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_OMP_BIN: '/no-provider-needed',
      },
    });
    await recover();
    const published = f.state.posts.findLast(post => post.path.endsWith('/reviews')).body;
    assert.equal(published.event, mode === 'approve' ? 'COMMENT' : 'REQUEST_CHANGES');
    assert.equal(published.commit_id, envelope.head);
    assert.deepEqual(published.comments, envelope.payload.comments);
    if (mode === 'approve') assert.ok(published.body.endsWith(envelope.payload.body));
    else assert.deepEqual(published, envelope.payload);
    assert.equal(f.state.reviews[0].state, mode === 'approve' ? 'COMMENTED' : 'CHANGES_REQUESTED');
    assert.equal(await readFile(path, 'utf8'), saved);
    const posts = f.state.posts.length;
    f.state.stale = false;
    f.state.closed = true;
    await recover();
    assert.equal(f.state.posts.length, posts);
    assert.equal(f.state.reviews.length, 1);
    assert.equal(await readFile(path, 'utf8'), saved);
    console.log(`PASS ${mode}, retained recovery: original envelope, movement policy and closed-PR idempotence`);
  } finally { await f.close(); }
}
