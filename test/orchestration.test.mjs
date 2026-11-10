import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { review } from '../src/review.mjs';
import { prompt } from '../src/prompt.mjs';
import { filesFromApi, inlineComment } from '../src/diff.mjs';
import { fixture } from './fixture.mjs';

const verdicts = f => f.state.posts.filter(post => post.path.endsWith('/reviews'));

test('real CLI orchestration publishes pinned native ranged changes request', async () => {
  const f = await fixture();
  try {
    await f.run({ mode: 'findings' });
    assert.equal(verdicts(f).length, 1);
    const result = verdicts(f)[0].body;
    assert.equal(result.event, 'REQUEST_CHANGES');
    assert.equal(result.commit_id, f.head);
    assert.equal(result.comments[0].side, 'LEFT');
    assert.equal(result.comments[1].start_side, 'RIGHT');
    assert.equal(result.comments[1].start_line, 1);
    assert.equal(result.comments[1].line, 2);
    assert.match(result.body, /codjiflo-reviewer:v4/);
  } finally { await f.close(); }
});

test('native publication records the workflow attempt without moving its final identity marker', async () => {
  const f = await fixture();
  try {
    await f.run({ providerEnv: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' } });
    assert.equal(verdicts(f).length, 1);
    assert.match(verdicts(f)[0].body.body, /<!-- codjiflo-workflow:123:2 -->\n<!-- codjiflo-publication:[a-f0-9-]+ -->$/);
  } finally { await f.close(); }
});

test('a mention located by comment ID reviews with the comment author, preset and mode', async () => {
  const f = await fixture();
  try {
    f.state.mention = { user: { login: 'Alice', type: 'User' }, body: 'Fixed. @codjiflo claude full' };
    await f.run({ mention: true, providerEnv: { GITHUB_RUN_ID: '123', GITHUB_REPOSITORY: 'bot-owner/bot-repo', GITHUB_SERVER_URL: 'https://github.example' } });
    const kickoff = f.state.posts.find(post => post.path === '/repos/org/repo/issues/1/comments').body.body;
    assert.match(kickoff, /starting \*\*opus-xhigh\*\* \(full\) at .*requested by @Alice\./);
    // The run link targets the repository hosting the workflow, not the reviewed one.
    assert.ok(kickoff.endsWith('[Live workflow logs](https://github.example/bot-owner/bot-repo/actions/runs/123)'));
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('a mention by an unapproved author or without a command performs no review work', async t => {
  for (const mention of [
    { user: { login: 'stranger', type: 'User' }, body: '@codjiflo claude' },
    { user: { login: 'Alice', type: 'User' }, body: 'Thanks @codjiflo for reviewing' },
  ]) await t.test(mention.body, async () => {
    const f = await fixture();
    try {
      f.state.mention = mention;
      await assert.rejects(f.run({ mention: true }), /Comment no longer requests an approved review/);
      assert.deepEqual(f.state.posts, []);
    } finally { await f.close(); }
  });
});

test('OMP output reaches the logs unless the workflow withholds it', async t => {
  for (const expected of ['withheld', 'live']) await t.test(expected, async () => {
    const f = await fixture();
    try {
      const stdout = await f.run({ providerEnv: { CODJIFLO_LOG_STREAM: expected } });
      assert.equal(stdout.includes('"type":"agent_start"'), expected === 'live');
      assert.equal(stdout.includes('OMP output withheld from logs'), expected === 'withheld');
      assert.equal(verdicts(f)[0].body.event, 'APPROVE');
    } finally { await f.close(); }
  });
});

test('OMP failures, malformed results and tool errors never approve', async t => {
  for (const scenario of ['failure', 'malformed', 'error-result']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.run({ mode: scenario }));
      assert.equal(verdicts(f).length, 0);
      assert.match(f.state.posts.at(-1).body.body, /failed/);
    } finally { await f.close(); }
  });
});

test('head/base movement and closure while collecting PR files reject the snapshot before invoking OMP', async t => {
  for (const scenario of ['head', 'base', 'both', 'closed']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      f.state.movement = scenario;
      await assert.rejects(f.run(), scenario === 'closed' ? /Pull request is not open/ : /changed while collecting file metadata/);
      await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
      assert.equal(verdicts(f).length, 0);
      assert.equal(f.state.reads, 2, 'snapshot mismatch must not start an automatic retry');
      assert.match(f.state.posts.at(-1).body.body, scenario === 'closed' ? /Pull request is not open/ : /request a new review/);
      if (scenario === 'closed') assert.doesNotMatch(f.state.posts.at(-1).body.body, /request a new review/);
    } finally { await f.close(); }
  });
});
test('revision movement or closure takes precedence over an incomplete file count', async t => {
  for (const scenario of ['head', 'base', 'both', 'closed', 'none']) {
    for (const delta of [-1, 1]) await t.test(`${scenario}, count ${delta > 0 ? 'increased' : 'decreased'}`, async () => {
      const f = await fixture();
      try {
        f.state.changedFiles += delta;
        f.state.movement = scenario;
        const error = scenario === 'closed' ? /Pull request is not open/
          : scenario === 'none' ? /Incomplete PR file metadata/
          : /changed while collecting file metadata/;
        await assert.rejects(f.run(), error);
        await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
        assert.equal(verdicts(f).length, 0);
      } finally { await f.close(); }
    });
  }
});


test('movement after snapshot validation makes either verdict neutral; closure rejects publication', async t => {
  for (const mode of ['approve', 'findings']) {
    for (const scenario of ['head', 'base', 'both', 'closed']) await t.test(`${mode}, ${scenario}`, async () => {
      const f = await fixture();
      try {
        f.state.moveAtRead = 3;
        f.state.movement = scenario;
        if (scenario === 'closed') {
          await assert.rejects(f.run({ mode }), /not open; refusing publication/);
          assert.equal(verdicts(f).length, 0);
        } else {
          await f.run({ mode });
          assert.equal(verdicts(f).length, 1);
          const result = verdicts(f)[0].body;
          const retained = JSON.parse(await readFile(join(f.temp, 'publication.json'), 'utf8'));
          assert.equal(result.event, 'COMMENT');
          assert.equal(f.state.reviews[0].state, 'COMMENTED');
          assert.equal(result.commit_id, f.head);
          assert.ok(result.body.includes(`Reviewed range: \`${f.base}..${f.head}\`\nPR base snapshot: \`${f.base}\``));
          const marker = JSON.parse(/<!-- codjiflo-reviewer:v4 (\{[^\n]+\}) -->/.exec(result.body)[1]);
          assert.equal(marker.head, f.head);
          assert.equal(marker.base, f.base);
          assert.equal(marker.preset, 'opus-xhigh');
          assert.equal(marker.findings.length, mode === 'approve' ? 0 : 2);
          assert.equal(retained.payload.event, mode === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES');
          assert.equal(result.commit_id, retained.payload.commit_id);
          assert.deepEqual(result.comments, retained.payload.comments);
          assert.ok(result.body.endsWith(retained.payload.body));
          assert.equal(retained.head, f.head);
          assert.equal(retained.base, f.base);
        }
        assert.match(await readFile(f.capture, 'utf8'), /final_review/);
      } finally { await f.close(); }
    });
  }
});

test('real failure publication redacts known publication and provider secrets without passing publication tokens to reviewer', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({
      mode: 'publication-secret-failure',
      providerEnv: {
        GH_TOKEN: 'fixture-gh-token-not-real',
        gItHuB_tOkEn: 'fixture-mixed-token-not-real',
        OPENAI_API_KEY: 'fixture-provider-key-not-real',
        FIXTURE_INSPECT_GIT: '1',
      },
    }));
    const context = JSON.parse(await readFile(f.capture + '.git-context', 'utf8'));
    assert.ok(!Object.keys(context.env).some(name => /^(?:GITHUB_TOKEN|GH_TOKEN)$/i.test(name)));
    assert.equal(context.env.OPENAI_API_KEY, 'fixture-provider-key-not-real');
    assert.equal(verdicts(f).length, 0);
    assert.equal(f.state.posts.length, 2);
    const failure = f.state.posts.at(-1);
    assert.equal(failure.path, '/repos/org/repo/issues/1/comments');
    assert.match(failure.body.body, /Codjiflo Reviewer failed/);
    assert.match(failure.body.body, /Fixture publication diagnostic github=\[REDACTED\] gh=\[REDACTED\] mixed=\[REDACTED\] provider=\[REDACTED\]/);
    for (const secret of ['fixture-token-not-real', 'fixture-gh-token-not-real', 'fixture-mixed-token-not-real', 'fixture-provider-key-not-real']) {
      assert.ok(!JSON.stringify(f.state.posts).includes(secret), secret);
    }
  } finally { await f.close(); }
});

test('environment-blocked and legacy defect-free outputs post only a neutral failure comment', async t => {
  for (const verdict of ['INCOMPLETE', 'REQUEST_CHANGES']) await t.test(verdict, async () => {
    const f = await fixture();
    try {
      const github = {
        token: 'fixture-token-not-real',
        async request(path, options) {
          if (options?.method === 'POST') {
            f.state.posts.push({ path, body: options.body });
            return { id: f.state.posts.length };
          }
          return { state: 'open', changed_files: f.state.files.length, head: { sha: f.head }, base: { sha: f.base, repo: { clone_url: pathToFileURL(f.repo).href } } };
        },
        async list() { return f.state.files; },
      };
      await assert.rejects(review({
        request: { repo: 'org/repo', number: 1, requester: 'Alice', preset: 'opus-xhigh', mode: 'full' },
        github,
        env: { ...f.env, CODJIFLO_APPROVED_USERS: 'alice' },
        reviewer: async () => ({
          verdict, findings: [], resolutions: [],
          summary: 'Review failed before analysis: PRIVATE-INCOMPLETE-SUMMARY host-only-secret=not-a-configured-credential.',
        }),
      }));
      assert.equal(verdicts(f).length, 0);
      assert.equal(f.state.posts.length, 2);
      assert.match(f.state.posts.at(-1).body.body, /failed/);
      assert.ok(f.state.posts.every(post => !post.path.endsWith('/reviews')));
      assert.doesNotMatch(f.state.posts.at(-1).body.body, /PRIVATE-INCOMPLETE-SUMMARY|host-only-secret|not-a-configured-credential/);
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

test('repository prompt replaces the default methodology with PR-head UTF-8 or empty text for every preset', async t => {
  for (const preset of ['claude', 'opus-medium']) for (const instructions of ['Check résumé parsing and preserve café identifiers.\nFocus on concurrency.', '']) await t.test(`${preset}: ${instructions === '' ? 'empty' : 'UTF-8'}`, async () => {
    const f = await fixture({ basePrompt: 'Old base instructions.', headPrompt: instructions });
    try {
      // Neither the base revision nor uncommitted content in the clone source may win.
      await writeFile(join(f.repo, '.codjiflo', 'code-review', 'PROMPT.md'), 'Uncommitted source instructions.');
      await f.run({ preset, full: true });
      const captured = await readFile(f.capture, 'utf8');
      const section = captured.slice(captured.indexOf('Repository review instructions'), captured.indexOf('Review-scope unified diff follows:'));
      assert.ok(section.includes(instructions));
      assert.ok(!section.includes('Old base instructions.'));
      assert.ok(!section.includes('Uncommitted source instructions.'));
      assert.match(section, /replacing the default methodology/);
      assert.ok(section.includes(`--- BEGIN REPOSITORY REVIEW INSTRUCTIONS ---\n${instructions}\n--- END REPOSITORY REVIEW INSTRUCTIONS ---`));
      for (const defaultText of ['e-code-review', 'independent angles', 'Target at least', 'Cap final findings', 'Conventions:', 'Do not run a verifier', 'do NOT spawn subagents', 'ReportFindings']) assert.ok(!captured.includes(defaultText), defaultText);
      assert.match(captured, /Review only; never edit repository files or publish to GitHub/);
      assert.match(captured, /final_review/);
      assert.ok(captured.includes(`PR head ${f.head}`));
      assert.equal(verdicts(f)[0].body.event, 'APPROVE');
    } finally { await f.close(); }
  });
});

test('oversized custom review output fails before publication', async () => {
  const f = await fixture({ headPrompt: 'Report every concrete defect.' });
  try {
    const github = {
      token: 'fixture-token-not-real',
      async request(path, options) {
        if (options?.method === 'POST') {
          f.state.posts.push({ path, body: options.body });
          return { id: f.state.posts.length };
        }
        return { state: 'open', changed_files: f.state.files.length, head: { sha: f.head }, base: { sha: f.base, repo: { clone_url: pathToFileURL(f.repo).href } } };
      },
      async list() { return f.state.files; },
    };
    await assert.rejects(review({
      request: { repo: 'org/repo', number: 1, requester: 'Alice', preset: 'opus-xhigh', mode: 'full' },
      github,
      env: { ...f.env, CODJIFLO_APPROVED_USERS: 'alice' },
      reviewer: async ({ prompt: instructions }) => {
        assert.match(instructions, /Report every concrete defect/);
        return {
          verdict: 'REQUEST_CHANGES', summary: 'Oversized review result.', resolutions: [],
          findings: Array.from({ length: 16 }, (_, index) => ({
            path: `module-${index}.js`, side: 'RIGHT', start_line: 1, line: 1,
            priority: 'P2', disposition: 'blocking', title: `Defect in module ${index}`,
            body: `Module ${index} loses its result on cancellation.`,
          })),
        };
      },
    }), /Malformed review output/);
    assert.equal(verdicts(f).length, 0);
    assert.match(f.state.posts.at(-1).body.body, /failed/);
  } finally { await f.close(); }
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
      const captured = await readFile(f.capture, 'utf8');
      assert.ok(!captured.includes('Repository review instructions'));
      assert.match(captured, /Apply this adapted e-code-review xhigh recipe/);
      assert.match(captured, /10 independent angles IN SEQUENCE/);
      assert.equal(verdicts(f)[0].body.event, 'APPROVE');
    } finally { await f.close(); }
  });
});

test('repository prompt rejects non-regular Git paths before provider launch or disclosure', async t => {
  for (const headPromptType of ['directory', 'symlink', 'parent-symlink', 'ancestor-symlink', 'submodule']) {
    for (const preset of ['claude', 'opus-medium']) await t.test(`${headPromptType}: ${preset}`, async () => {
      // Symlink targets are readable host files outside the repository, not dangling links.
      const f = await fixture({ headPromptType });
      try {
        assert.equal(await readFile(join(f.temp, 'host', 'code-review', 'PROMPT.md'), 'utf8'), f.hostSentinel);
        await assert.rejects(f.run({ preset }), /must be a regular Git blob/);
        assert.equal(verdicts(f).length, 0);
        await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
        assert.match(f.state.posts.at(-1).body.body, /failed/);
        assert.ok(!JSON.stringify(f.state.posts).includes(f.hostSentinel));
      } finally { await f.close(); }
    });
  }
});

test('fixture API metadata includes prompt additions, modifications and deletions', async t => {
  for (const [status, options, additions, deletions] of [
    ['added', { headPrompt: 'Added instructions.\n' }, 1, 0],
    ['modified', { basePrompt: 'Old instructions.\n', headPrompt: 'New instructions.\n' }, 1, 1],
    ['removed', { basePrompt: 'Deleted instructions.\n', headPrompt: null }, 0, 1],
  ]) await t.test(status, async () => {
    const f = await fixture(options);
    try {
      assert.equal(f.state.changedFiles, 2);
      assert.equal(f.state.files.length, 2);
      assert.equal(f.state.files[0].filename, 'a.js');
      const file = f.state.files.find(file => file.filename === '.codjiflo/code-review/PROMPT.md');
      assert.ok(file);
      assert.equal(file.status, status);
      assert.equal(file.additions, additions);
      assert.equal(file.deletions, deletions);
      assert.match(file.patch, /^@@ /);
      if (options.headPrompt) assert.ok(file.patch.includes(`+${options.headPrompt.trimEnd()}`));
      if (options.basePrompt) assert.ok(file.patch.includes(`-${options.basePrompt.trimEnd()}`));
      await f.run({ full: true });
      const captured = await readFile(f.capture, 'utf8');
      const metadataMarker = 'Authoritative current PR file metadata and patches for location mapping ONLY (LEFT is the PR old snapshot, not the incremental old snapshot):\n';
      const apiPatches = JSON.parse(captured.slice(captured.indexOf(metadataMarker) + metadataMarker.length));
      assert.ok(apiPatches.some(patch => patch.filename === file.filename && patch.patch === file.patch));
    } finally { await f.close(); }
  });
});

test('fixture preserves trailing blank prompt context as valid API anchors', async () => {
  const f = await fixture({ basePrompt: 'old\n\n', headPrompt: 'new\n\n' });
  try {
    const path = '.codjiflo/code-review/PROMPT.md';
    const metadata = f.state.files.find(file => file.filename === path);
    assert.ok(metadata.patch.endsWith('\n '));
    const files = filesFromApi(f.state.files);
    assert.equal(files.get(path).patch, metadata.patch);
    for (const [side, line] of [['LEFT', 1], ['RIGHT', 1], ['RIGHT', 2]]) {
      const comment = inlineComment({ path, side, start_line: line, line, priority: 'P2', title: 'Fixture anchor', body: 'Valid API location.' }, files);
      assert.equal(comment.side, side);
      assert.equal(comment.line, line);
    }
    await f.run({ full: true });
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('repository instruction identity governs successful incremental baselines', async t => {
  for (const [scenario, options, changed] of [
    ['content changed', { basePrompt: 'Original instructions.\n', headPrompt: 'Changed instructions.\n' }, true],
    ['added', { headPrompt: 'Added instructions.\n' }, true],
    ['deleted', { basePrompt: 'Deleted instructions.\n', headPrompt: null }, true],
    ['unchanged blob', { basePrompt: 'Same instructions.\n', headPrompt: 'Same instructions.\n' }, false],
    ['absent at both heads', {}, false],
  ]) await t.test(scenario, async () => {
    const f = await fixture(options);
    try {
      f.state.reviews = [{ state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head: f.previous, base: f.base, preset: 'opus-xhigh', findings: [], kickoffId: 1 })} -->` }];
      await f.run();
      const result = verdicts(f)[0].body;
      const captured = await readFile(f.capture, 'utf8');
      const scopeDiff = captured.slice(captured.indexOf('Review-scope unified diff follows:'), captured.indexOf('Authoritative current PR file metadata'));
      assert.equal(result.event, 'APPROVE');
      if (changed) {
        assert.match(result.body, /Scope: \*\*full\*\*/);
        assert.ok(result.body.includes(`Reviewed range: \`${f.base}..${f.head}\`\nPR base snapshot: \`${f.base}\``));
        assert.ok(captured.includes(`git diff ${f.base} ${f.head}`));
        assert.ok(scopeDiff.includes('-old\n'));
        assert.ok(scopeDiff.includes('+new\n'));
        assert.ok(scopeDiff.includes('-second\n'));
        assert.ok(scopeDiff.includes('+changed\n'));
      } else {
        assert.match(result.body, /Scope: \*\*incremental\*\*/);
        assert.ok(result.body.includes(`Reviewed range: \`${f.previous}..${f.head}\`\nPR base snapshot: \`${f.base}\``));
        assert.ok(captured.includes(`git diff ${f.previous} ${f.head}`));
        assert.ok(!scopeDiff.includes('-old\n'));
        assert.ok(!scopeDiff.includes('+new\n'));
        assert.ok(scopeDiff.includes('-second\n'));
        assert.ok(scopeDiff.includes('+changed\n'));
      }
    } finally { await f.close(); }
  });
});

test('legacy approvals cannot reuse an unchanged preexisting repository prompt', async t => {
  for (const version of ['v1', 'v2', 'v3']) await t.test(version, async () => {
    const instructions = 'Check all source edits against these repository instructions.\n';
    const f = await fixture({ basePrompt: instructions, headPrompt: instructions });
    try {
      f.state.reviews = [{
        user: { type: 'Bot' }, state: 'APPROVED', commit_id: f.previous,
        body: `<!-- codjiflo-reviewer:${version} ${JSON.stringify({ head: f.previous, base: f.base, preset: 'opus-xhigh' })} -->`,
      }];
      await f.run();
      const result = verdicts(f)[0].body;
      const captured = await readFile(f.capture, 'utf8');
      const scopeDiff = captured.slice(captured.indexOf('Review-scope unified diff follows:'), captured.indexOf('Authoritative current PR file metadata'));
      assert.equal(result.event, 'APPROVE');
      assert.ok(captured.includes(instructions));
      assert.match(result.body, /codjiflo-reviewer:v4 /);
      assert.match(result.body, /Scope: \*\*full\*\*/);
      assert.ok(captured.includes(`git diff ${f.base} ${f.head}`));
      assert.ok(scopeDiff.includes('-old\n'));
      assert.ok(scopeDiff.includes('+new\n'));
      assert.ok(scopeDiff.includes('-second\n'));
      assert.ok(scopeDiff.includes('+changed\n'));
    } finally { await f.close(); }
  });
});


test('local aliases and mixed-case canonical names retain canonical publication and baseline scope', async t => {
  for (const [input, preset] of [['CLAUDE', 'opus-xhigh'], ['OpUs-XhIgH', 'opus-xhigh'], ['OPUS-MEDIUM', 'opus-medium']]) await t.test(input, async () => {
    const f = await fixture();
    try {
      f.state.reviews = [{ user: { type: 'Bot' }, state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head: f.previous, base: f.base, preset, findings: [], kickoffId: 1 })} -->` }];
      await f.run({ preset: input });
      const result = verdicts(f)[0].body;
      assert.equal(result.event, 'APPROVE');
      assert.match(f.state.posts[0].body.body, new RegExp(`starting \\*\\*${preset}\\*\\*`));
      assert.ok(result.body.startsWith(`## Codjiflo Reviewer — ${preset}\n`));
      assert.match(result.body, /Scope: \*\*incremental\*\*/);
      const marker = JSON.parse(/<!-- codjiflo-reviewer:v4 (\{[^\n]+\}) -->/.exec(result.body)[1]);
      assert.deepEqual(marker, { head: f.head, base: f.base, preset, findings: [], kickoffId: 100 + f.state.posts.findIndex(post => post.path.endsWith('/comments')) + 1 });
    } finally { await f.close(); }
  });
});

test('local unknown presets are rejected before HTTP requests or provider launch', async () => {
  const f = await fixture();
  try {
    for (const preset of ['opus-high', 'codex']) await assert.rejects(f.run({ preset }));
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

test('completed checkpoints, explicit full, same head and changed preset choose correct scope', async t => {
  for (const scenario of ['incremental', 'full', 'base-change', 'rebase', 'same-head', 'preset-change']) await t.test(scenario, async () => {
    const f = await fixture();
    try {
      const prior = scenario === 'rebase' ? 'f'.repeat(40) : scenario === 'same-head' ? f.head : f.previous;
      const base = scenario === 'base-change' ? 'c'.repeat(40) : f.base;
      const approved = { user: { type: 'Bot' }, state: 'APPROVED', commit_id: prior, body: `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head: prior, base, preset: 'opus-xhigh', findings: [], kickoffId: 1 })} -->` };
      f.state.reviews = [approved];
      await f.run({ full: scenario === 'full', preset: scenario === 'preset-change' ? 'opus-medium' : 'opus-xhigh' });
      assert.match(verdicts(f)[0].body.body, new RegExp(`Scope: \\*\\*${scenario === 'incremental' ? 'incremental' : 'full'}\\*\\*`));
      assert.equal(verdicts(f).length, 1);
    } finally { await f.close(); }
  });
});

test('a latest marked withheld-approval COMMENTED review prevents reuse of an earlier approval', async () => {
  const f = await fixture();
  try {
    const marked = { commit_id: f.previous, body: `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head: f.previous, base: f.base, preset: 'opus-xhigh', findings: [], kickoffId: 1 })} -->` };
    f.state.reviews = [
      { ...marked, state: 'APPROVED' },
      { ...marked, state: 'COMMENTED' },
    ];
    await f.run();
    assert.equal(verdicts(f).length, 1);
    assert.match(verdicts(f)[0].body.body, /Scope: \*\*full\*\*/);
    const captured = await readFile(f.capture, 'utf8');
    assert.ok(captured.includes(`git diff ${f.base} ${f.head}`));
    assert.ok(captured.includes('-old\n'));
    assert.ok(captured.includes('+new\n'));
  } finally { await f.close(); }
});

test('full and incremental native coordinates use API patches rather than local diff', async t => {
  for (const full of [false, true]) await t.test(String(full), async () => {
    const f = await fixture();
    try {
      f.state.reviews = [{ user: { type: 'User' }, state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head: f.previous, base: f.base, preset: 'opus-xhigh', findings: [], kickoffId: 1 })} -->` }];
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
