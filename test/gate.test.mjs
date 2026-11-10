import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/runner.mjs';
import { repositorySettings } from '../src/repositories.mjs';

const cli = fileURLToPath(new URL('../bin/codjiflo-reviewer.mjs', import.meta.url));

// Loopback GitHub serving the one comment the dispatch inputs point at.
async function gate({ repo = 'org/repo', author = 'alice', type = 'User', body = '@codjiflo-reviewer review', approved = 'alice', pr = true, visibility = { private: false }, args } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-gate-'));
  const requests = [];
  const comments = [];
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === `/repos/${repo}/issues/2025/comments`) {
      let posted = ''; for await (const chunk of request) posted += chunk;
      comments.push(JSON.parse(posted).body);
      return response.end('{"id":1}');
    }
    const found = {
      [`/repos/${repo}/issues/comments/6451172747`]: { id: 6451172747, user: { login: author, type }, body, issue_url: `https://api.github.example/repos/${repo}/issues/2025` },
      [`/repos/${repo}/issues/2025`]: { number: 2025, ...(pr ? { pull_request: {} } : {}) },
      [`/repos/${repo}`]: visibility,
    }[request.url];
    if (!found) response.statusCode = 404;
    response.end(JSON.stringify(found ?? { message: 'Not Found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const outputPath = join(temp, 'output');
  const summaryPath = join(temp, 'summary');
  const running = runProcess(process.execPath, [cli, ...(args ?? ['--gate', '--repo', repo, '--comment', '6451172747'])], {
    env: {
      ...process.env, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_TOKEN: 'fixture-token-not-real', GH_TOKEN: '',
      CODJIFLO_APPROVED_USERS: approved, CODJIFLO_OMP_BIN: '/nonexistent-reviewer',
    },
  });
  const read = path => readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
  return {
    running, requests, comments,
    output: () => read(outputPath), summary: () => read(summaryPath),
    async close() { await running.catch(() => {}); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); },
  };
}

test('gate authorizes only the fetched comment author against the allowlist', async t => {
  for (const [author, approved, expected] of [
    ['ALICE', 'alice,bob', 'true'],
    ['stranger', 'alice,bob', 'false'],
    ['alice', '', 'false'],
  ]) await t.test(`${author} with ${approved || 'empty allowlist'}`, async () => {
    const g = await gate({ author, approved });
    try {
      await g.running;
      assert.equal((await g.output()).split('\n')[0], `allowed=${expected}`);
    } finally { await g.close(); }
  });
});

test('gate explains every decision in logs and the Actions summary without starting review work', async t => {
  const cases = [
    { name: 'embedded command', body: 'Owner authorized option (A). @codjiflo opus-medium', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-medium', mode: 'incremental' },
    { name: 'Claude full command', body: 'Please @codjiflo claude full', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-xhigh', mode: 'full' },
    { name: 'embedded command ends paragraph', body: 'Owner authorized option (A). @codjiflo opus-medium\n\nThanks for taking another look.', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-medium', mode: 'incremental' },
    { name: 'explicit Claude command ends paragraph', body: 'Please @codjiflo-reviewer review claude full\n\nFurther context below.', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-xhigh', mode: 'full' },
    { name: 'ordinary comment', body: 'Thanks @codjiflo for reviewing', reason: 'not-a-command' },
    { name: 'quoted command', body: '> @codjiflo opus-medium', reason: 'not-a-command' },
    { name: 'casual review question', body: 'Could @codjiflo review this?', reason: 'not-a-command' },
    { name: 'casual known profile', body: 'Thanks @codjiflo claude did great', reason: 'not-a-command' },
    { name: 'soft-wrapped review prose', body: 'I think the earlier pass by @codjiflo review\nmissed this', reason: 'not-a-command' },
    { name: 'soft-wrapped profile prose', body: 'Thanks to @codjiflo claude\nfor the review', reason: 'not-a-command' },
    { name: 'inline code prefix before malformed mention', body: '`x` @codjiflo review turbo', reason: 'not-a-command' },
    { name: 'soft-wrapped prose before standalone command', body: 'Thanks to @codjiflo claude\nfor the review\n\n@codjiflo opus-medium', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-medium', mode: 'incremental' },
    { name: 'casual mention before valid command', body: 'Could @codjiflo review this?\n@codjiflo opus-medium', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-medium', mode: 'incremental' },
    { name: 'indented code command', body: 'Example:\n\n    @codjiflo opus-medium', reason: 'not-a-command' },
    { name: 'paragraph continuation command', body: 'Owner authorized:\n    @codjiflo opus-medium', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-medium', mode: 'incremental' },
    { name: 'unmatched backticks in separate paragraphs', body: '`example\n\n@codjiflo opus-medium\n\n`', allowed: true, reason: 'approved', provider: 'anthropic', preset: 'opus-medium', mode: 'incremental' },
    { name: 'bot kickoff', author: 'codjiflo[bot]', type: 'Bot', body: 'Starting review', reason: 'bot-author' },
    { name: 'allowlisted bot command', author: 'codjiflo[bot]', type: 'Bot', approved: 'codjiflo[bot]', body: '@codjiflo opus-medium', reason: 'bot-author' },
    { name: 'bot login without type', author: 'codjiflo[bot]', type: undefined, body: '@codjiflo opus-medium', reason: 'bot-author' },
    { name: 'unapproved command', author: 'stranger', body: '@codjiflo opus-medium', reason: 'not-approved' },
    { name: 'unapproved malformed command', author: 'stranger', body: '@codjiflo review turbo', reason: 'not-approved' },
    { name: 'issue command', pr: false, body: '@codjiflo opus-medium', reason: 'not-a-pr' },
    { name: 'invalid standalone command', body: '@codjiflo review turbo', reason: 'invalid-command', fails: true },
    { name: 'codex shorthand is not a command', body: '@codjiflo codex', reason: 'not-a-command' },
    { name: 'standalone codex preset is invalid', body: '@codjiflo review codex', reason: 'invalid-command', fails: true },
    { name: 'malformed prose mention', body: 'Please @codjiflo review turbo', reason: 'not-a-command' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const author = scenario.author ?? 'alice';
    const g = await gate({ author, ...('type' in scenario ? { type: scenario.type } : {}), body: scenario.body, approved: scenario.approved ?? 'alice', pr: scenario.pr !== false });
    try {
      const allowed = Boolean(scenario.allowed);
      const line = `gate: allowed=${allowed} reason=${scenario.reason}${allowed ? ` provider=${scenario.provider} preset=${scenario.preset} mode=${scenario.mode}` : ''} author=${author} comment=6451172747 pr=${scenario.pr === false ? 'none' : '#2025'}`;
      if (scenario.fails) await assert.rejects(g.running, /Invalid review command/);
      else assert.equal(await g.running, `${line}\n`);
      assert.equal(await g.output(), `allowed=${allowed}\nprovider=${scenario.provider ?? 'none'}\n${allowed ? 'number=2025\nvisibility=public\nprepare-command=\nsource-submodules=[]\n' : ''}`);
      assert.equal(await g.summary(), `## Codjiflo gate\n\n<pre>${line}</pre>\n`);
      // Denials never spend the repository lookup. Only an approved author's
      // malformed command is answered on the PR, without echoing the comment.
      assert.equal(g.requests.filter(request => request.startsWith('GET ')).length, allowed ? 3 : 2);
      assert.ok(g.requests.every(request => request.endsWith(' Bearer fixture-token-not-real')));
      assert.deepEqual(g.comments, scenario.fails ? ['Codjiflo Reviewer did not start: Invalid review command. Use @codjiflo review [opus-xhigh|opus-medium|claude] [full|incremental] or @codjiflo <preset> [full|incremental]'] : []);
    } finally { await g.close(); }
  });
});

test('repository settings match the repository case-insensitively and reject malformed entries', () => {
  const config = { 'Org/Repo': { prepareCommand: 'node prepare.mjs', sourceSubmodules: ['sdk'] } };
  assert.deepEqual(repositorySettings(config, 'org/REPO'), { prepareCommand: 'node prepare.mjs', sourceSubmodules: ['sdk'] });
  assert.deepEqual(repositorySettings(config, 'org/other'), { prepareCommand: '', sourceSubmodules: [] });
  for (const entry of [{ prepareCommand: 'a\nb' }, { sourceSubmodules: 'sdk' }, { sourceSubmodules: [1] }, { prepareComand: 'typo' }]) {
    assert.throws(() => repositorySettings({ 'org/repo': entry }, 'org/repo'), /repositories\.json org\/repo/);
  }
  assert.throws(() => repositorySettings([], 'org/repo'), /must be an object/);
});

for (const [name, visibility] of [['private', { private: true }], ['unstated', {}]]) {
  test(`gate keeps a repository with ${name} visibility out of public retention`, async () => {
    const g = await gate({ visibility });
    try {
      await g.running;
      assert.match(await g.output(), /\nvisibility=private\n/);
    } finally { await g.close(); }
  });
}

for (const args of [
  ['--gate', '--repo', '../admin', '--comment', '1'],
  ['--gate', '--repo', 'org/repo/extra', '--comment', '1'],
  ['--gate', '--repo', 'org/repo', '--comment', '1/../../pulls'],
  ['--gate', '--repo', 'org/repo', '--comment', '0'],
]) test(`gate rejects malformed dispatch inputs before any request: ${args.slice(2).join(' ')}`, async () => {
  const g = await gate({ args });
  try {
    await assert.rejects(g.running, /Valid --repo owner\/repo and --comment ID required/);
    assert.deepEqual(g.requests, []);
    assert.equal(await g.output(), '');
  } finally { await g.close(); }
});
