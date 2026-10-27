import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prompt } from '../src/prompt.mjs';
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
      await assert.rejects(f.run({ mode: scenario, preset: scenario === 'error-result' ? 'opus-xhigh' : 'sol-xhigh' }));
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

test('repository prompt uses UTF-8 instructions from PR head for both providers', async t => {
  for (const preset of ['codex', 'claude']) await t.test(preset, async () => {
    const instructions = 'Check résumé parsing and preserve café identifiers.\nFocus on concurrency.';
    const f = await fixture({ basePrompt: 'Old base instructions.', headPrompt: instructions });
    try {
      // Neither the base revision nor uncommitted content in the clone source may win.
      await writeFile(join(f.repo, '.codjiflo', 'code-review', 'PROMPT.md'), 'Uncommitted source instructions.');
      await f.run({ preset, full: true });
      const captured = await readFile(f.capture, 'utf8');
      const section = captured.slice(captured.indexOf('Repository supplemental instructions'), captured.indexOf('Review-scope unified diff follows:'));
      assert.ok(section.includes(instructions));
      assert.ok(!section.includes('Old base instructions.'));
      assert.ok(!section.includes('Uncommitted source instructions.'));
      assert.match(section, /supplement.*do not override/);
      assert.match(section, /BEGIN REPOSITORY SUPPLEMENTAL INSTRUCTIONS/);
      assert.match(section, /END REPOSITORY SUPPLEMENTAL INSTRUCTIONS/);
      assert.match(captured, /Apply this adapted e-code-review xhigh recipe/);
      assert.match(captured, /exactly one final JSON object matching the supplied schema/);
      assert.match(captured, /All native comment locations must use the authoritative CURRENT PR API patches/);
      assert.ok(captured.includes(`PR head ${f.head}`));
      assert.equal(verdicts(f)[0].body.event, 'APPROVE');
    } finally { await f.close(); }
  });
});

test('missing repository prompt preserves the default prompt, including after deletion at PR head', async t => {
  for (const options of [{}, { basePrompt: 'Deleted instructions.', headPrompt: null }]) await t.test(JSON.stringify(options), async () => {
    const f = await fixture(options);
    try {
      await f.run({ full: true });
      const currentDiff = JSON.stringify(f.state.files.map(file => ({ filename: file.filename, patch: file.patch })), null, 2);
      assert.equal(await readFile(f.capture, 'utf8'), prompt({
        level: 'xhigh', mode: 'full', base: f.base, head: f.head, scope: f.base, diff: f.localDiff, currentDiff,
      }));
      assert.ok(!(await readFile(f.capture, 'utf8')).includes('Repository supplemental instructions'));
      assert.equal(verdicts(f)[0].body.event, 'APPROVE');
    } finally { await f.close(); }
  });
});

test('repository prompt read errors other than ENOENT fail before provider launch or publication', async () => {
  const f = await fixture({ promptDirectory: true });
  try {
    await assert.rejects(f.run(), /EISDIR/);
    assert.equal(verdicts(f).length, 0);
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
    assert.match(f.state.posts.at(-1).body.body, /failed/);
  } finally { await f.close(); }
});

test('Claude OAuth fallback clears inherited API and cloud-provider environment', async () => {
  const f = await fixture();
  try {
    await f.run({ preset: 'claude', providerEnv: {
      ANTHROPIC_API_KEY: 'host-key-must-not-be-used', ANTHROPIC_AUTH_TOKEN: 'host-token-must-not-be-used',
      ANTHROPIC_BASE_URL: 'https://must-not-contact.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'must-use-stored-login',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    } });
    assert.equal(verdicts(f).length, 1);
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('present invalid Claude key configuration fails closed before CLI launch or publication', async () => {
  const f = await fixture();
  try {
    await writeFile(f.env.CODJIFLO_ANTHROPIC_KEYS_FILE, '{', { mode: 0o600 });
    await assert.rejects(f.run({ preset: 'claude' }));
    assert.equal(verdicts(f).length, 0);
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
    assert.match(f.state.posts.at(-1).body.body, /failed/);
  } finally { await f.close(); }
});

test('local aliases and mixed-case canonical names retain canonical publication and baseline scope', async t => {
  for (const [input, preset] of [['CoDeX', 'sol-xhigh'], ['CLAUDE', 'opus-xhigh'], ['SOL-XHIGH', 'sol-xhigh'], ['OpUs-XhIgH', 'opus-xhigh']]) await t.test(input, async () => {
    const f = await fixture();
    try {
      f.state.reviews = [{ user: { type: 'Bot' }, state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head: f.previous, base: f.base, preset })} -->` }];
      await f.run({ preset: input });
      const result = verdicts(f)[0].body;
      assert.equal(result.event, 'APPROVE');
      assert.match(f.state.posts[0].body.body, new RegExp(`starting \\*\\*${preset}\\*\\*`));
      assert.ok(result.body.startsWith(`## Codjiflo Reviewer — ${preset}\n`));
      assert.match(result.body, /Scope: \*\*incremental\*\*/);
      const marker = JSON.parse(/<!-- codjiflo-reviewer:v1 (\{[^\n]+\}) -->/.exec(result.body)[1]);
      assert.deepEqual(marker, { head: f.head, base: f.base, preset });
    } finally { await f.close(); }
  });
});

test('local replaced high names are rejected before HTTP requests or provider launch', async () => {
  const f = await fixture();
  try {
    for (const preset of ['sol-high', 'opus-high']) await assert.rejects(f.run({ preset }));
    assert.equal(f.state.requests.length, 0);
    await assert.rejects(readFile(f.capture));
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

test('ancestor approval, explicit full, PAT blockers, same head and changed preset choose correct scope', async t => {
  for (const scenario of ['incremental', 'full', 'blockers', 'base-change', 'rebase', 'same-head', 'preset-change']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      const prior = scenario === 'rebase' ? 'f'.repeat(40) : scenario === 'same-head' ? f.head : f.previous;
      const base = scenario === 'base-change' ? 'c'.repeat(40) : f.base;
      const approved = { user: { type: 'Bot' }, state: 'APPROVED', commit_id: prior, body: `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head: prior, base, preset: 'sol-xhigh' })} -->` };
      f.state.reviews = [approved, ...(scenario === 'blockers' ? [{ ...approved, user: { type: 'User' }, state: 'CHANGES_REQUESTED' }] : [])];
      await f.run({ full: scenario === 'full', preset: scenario === 'preset-change' ? 'opus-xhigh' : 'sol-xhigh' });
      assert.match(verdicts(f)[0].body.body, new RegExp(`Scope: \\*\\*${scenario === 'incremental' ? 'incremental' : 'full'}\\*\\*`));
      assert.equal(verdicts(f).length, 1);
    } finally { await f.close(); }
  });
});

test('full and incremental native coordinates use API patches rather than local diff', async t => {
  for (const full of [false, true]) await t.test(String(full), async () => {
    const f = await fixture();
    try {
      f.state.reviews = [{ user: { type: 'User' }, state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head: f.previous, base: f.base, preset: 'sol-xhigh' })} -->` }];
      f.state.files[0].patch = '@@ -20,2 +20,2 @@\n-old\n-second\n+new\n+changed';
      await f.run({ mode: 'findings', full });
      const result = verdicts(f)[0].body;
      assert.equal(result.event, 'REQUEST_CHANGES');
      assert.deepEqual(result.comments, []);
      assert.match(result.body, /Old-side bug/);
      assert.match(result.body, /Range bug/);
    } finally { await f.close(); }
  });
});

test('files metadata is paginated and incomplete or over-limit listings fail without verdict', async t => {
  for (const scenario of ['pagination', 'incomplete', 'limit']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      f.state.changedFiles = scenario === 'limit' ? 3001 : 101;
      if (scenario === 'pagination') f.state.files = Array.from({ length: 101 }, (_, index) => ({ ...f.state.files[0], filename: `file-${index}.js` }));
      if (scenario === 'pagination') {
        await f.run();
        assert.equal(verdicts(f)[0].body.event, 'APPROVE');
        assert.ok(f.state.requests.some(request => request.path.endsWith('/files?per_page=100&page=2')));
      } else {
        await assert.rejects(f.run());
        assert.equal(verdicts(f).length, 0);
      }
    } finally { await f.close(); }
  });
});
