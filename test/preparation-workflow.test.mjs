import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workflow preparation failure reporter posts a neutral PR comment with exact run logs', async () => {
  // Execute the actual GitHub Script payload against its documented API/context,
  // without invoking GitHub or running a host preparation command.
  const workflow = await readFile(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => line.trim() === 'script: |');
  assert.ok(start >= 0, 'workflow contains its failure-report script');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith('            ')) break;
    body.push(line.slice(12));
  }
  const posts = [];
  const github = { rest: { issues: { createComment: async request => { posts.push(request); } } } };
  const context = {
    serverUrl: 'https://github.example', repo: { owner: 'owner', repo: 'repo' },
    issue: { number: 1987 }, runId: 40441453630,
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('github', 'context', body.join('\n'))(github, context);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].owner, 'owner');
  assert.equal(posts[0].repo, 'repo');
  assert.equal(posts[0].issue_number, 1987);
  assert.match(posts[0].body, /preparation failed/);
  assert.match(posts[0].body, /no review verdict was submitted/);
  assert.ok(posts[0].body.includes('https://github.example/owner/repo/actions/runs/40441453630'));
  assert.equal(posts[0].event, undefined);
});
