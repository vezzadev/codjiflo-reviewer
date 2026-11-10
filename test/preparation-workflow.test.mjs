import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n');
const start = lines.findIndex(line => line.trim() === '- name: Report preparation failure');
assert.ok(start >= 0, 'workflow contains its failure-report step');
const end = lines.findIndex((line, index) => index > start && line.startsWith('      - '));
const reporter = lines.slice(start, end < 0 ? undefined : end);
const condition = reporter.find(line => line.trim().startsWith('if:')).trim().slice(4);
const scriptStart = reporter.findIndex(line => line.trim() === 'script: |');
assert.ok(scriptStart >= 0, 'reporter contains its executable script');
const body = reporter.slice(scriptStart + 1).map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const reportFailure = new AsyncFunction('github', 'context', 'process', body);
const shouldReport = new Function('failure', 'steps', `return ${condition};`);

test('workflow reports a preparation failure on the reviewed PR without a verdict or host output', async () => {
  // Evaluate the workflow's real guard and execute its real GitHub Script payload.
  // No GitHub request or runner setup command is invoked.
  assert.equal(shouldReport(() => true, { prepare: { outcome: 'failure' } }), true);
  const posts = [];
  const github = { rest: { issues: { createComment: async request => { posts.push(request); } } } };
  const context = {
    serverUrl: 'https://github.example', repo: { owner: 'bot-owner', repo: 'bot-repo' }, runId: 40441453630,
  };
  await reportFailure(github, context, { env: { TARGET_REPOSITORY: 'owner/repo', TARGET_PR: '1987' } });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].owner, 'owner');
  assert.equal(posts[0].repo, 'repo');
  assert.equal(posts[0].issue_number, 1987);
  assert.match(posts[0].body, /preparation failed/);
  assert.match(posts[0].body, /no review verdict was submitted/);
  assert.ok(posts[0].body.includes('https://github.example/bot-owner/bot-repo/actions/runs/40441453630'));
  assert.equal(posts[0].event, undefined);
});

test('setup reporter does not duplicate CLI failure reporting or report successful setup', () => {
  for (const review of ['success', 'failure', 'skipped']) {
    assert.equal(shouldReport(() => review === 'failure', { prepare: { outcome: 'skipped' } }), false);
  }
  assert.equal(shouldReport(() => false, { prepare: { outcome: 'failure' } }), false, 'failure() remains required');
});
