import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture.mjs';

// No remote writes, credentials or real provider account required. This launches
// the actual entry point, git checkout/fetch, native-fetch HTTP client and CLI adapter.
for (const [preset, canonical] of [['codex', 'sol-xhigh'], ['claude', 'opus-xhigh']]) {
 for (const headPrompt of [undefined, 'Review café parsing and résumé handling.\nCheck cancellation paths.']) {
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
    if (headPrompt === undefined) assert.ok(!captured.includes('Repository supplemental instructions'));
    else {
      const section = captured.slice(captured.indexOf('Repository supplemental instructions'), captured.indexOf('Review-scope unified diff follows:'));
      assert.ok(section.includes(headPrompt));
      assert.match(section, /supplement.*do not override/);
    }
    console.log(`PASS ${preset} (${headPrompt === undefined ? 'default' : 'custom UTF-8 prompt'}): real orchestration, kickoff, pinned native review and LEFT/RIGHT ranges`);
  } finally { await f.close(); }
 }
}
const stale = await fixture();
try {
  stale.state.stale = true;
  await assert.rejects(stale.run());
  assert.equal(stale.state.posts.some(post => post.path.endsWith('/reviews')), false);
  console.log('PASS stale-head race: no verdict published');
} finally { await stale.close(); }
