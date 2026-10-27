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
const reportFailure = new AsyncFunction('github', 'context', body);
const shouldReport = new Function('failure', 'steps', `return ${condition};`);

for (const failedStep of ['sdk', 'prepare', 'app']) {
  test(`workflow reports ${failedStep} setup failure without a verdict or host output`, async () => {
    // Evaluate the workflow's real guard and execute its real GitHub Script payload.
    // No GitHub request or runner setup command is invoked.
    const steps = Object.fromEntries(['sdk', 'prepare', 'app', 'review'].map(id => [
      id, { outcome: id === failedStep ? 'failure' : 'skipped' },
    ]));
    assert.equal(shouldReport(() => true, steps), true);
    const posts = [];
    const github = { rest: { issues: { createComment: async request => { posts.push(request); } } } };
    const context = {
      serverUrl: 'https://github.example', repo: { owner: 'owner', repo: 'repo' },
      issue: { number: 1987 }, runId: 40441453630,
    };
    await reportFailure(github, context);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].owner, 'owner');
    assert.equal(posts[0].repo, 'repo');
    assert.equal(posts[0].issue_number, 1987);
    assert.match(posts[0].body, /preparation failed/);
    assert.match(posts[0].body, /no review verdict was submitted/);
    assert.match(posts[0].body, /SDK installation/);
    assert.match(posts[0].body, /GitHub App token setup/);
    assert.ok(posts[0].body.includes('https://github.example/owner/repo/actions/runs/40441453630'));
    assert.equal(posts[0].event, undefined);
  });
}

test('setup reporter does not duplicate CLI failure reporting or report successful setup', () => {
  for (const review of ['success', 'failure', 'skipped']) {
    const steps = {
      sdk: { outcome: 'success' }, prepare: { outcome: 'skipped' },
      app: { outcome: 'success' }, review: { outcome: review },
    };
    assert.equal(shouldReport(() => review === 'failure', steps), false);
  }
  const steps = {
    sdk: { outcome: 'failure' }, prepare: { outcome: 'skipped' },
    app: { outcome: 'skipped' }, review: { outcome: 'skipped' },
  };
  assert.equal(shouldReport(() => false, steps), false, 'failure() remains required');
});
