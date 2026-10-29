import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');
const reporter = workflow.slice(workflow.indexOf('  report_failure:\n'));
const condition = reporter.split('\n').find(line => line.trim().startsWith('if:')).trim().slice(4);
const shouldReport = new Function('always', 'needs', `return ${condition};`);
const script = reporter.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('github', 'context', 'process', script);
const context = {
  serverUrl: 'https://github.example', repo: { owner: 'owner', repo: 'repo' },
  issue: { number: 1995 }, runId: 40601533783,
};
const runUrl = `${context.serverUrl}/owner/repo/actions/runs/${context.runId}`;
const marker = `<!-- codjiflo-workflow:${context.runId}:2 -->`;
const bot = { type: 'Bot' };

async function report({ comments = [], reviews = [], result = 'failure', attempt = '2' } = {}) {
  const posts = [];
  const reads = [];
  const listComments = () => {};
  const listReviews = () => {};
  const github = {
    rest: {
      actions: { getWorkflowRunAttempt: async request => {
        assert.deepEqual(request, { owner: 'owner', repo: 'repo', run_id: context.runId, attempt_number: Number(attempt) });
        reads.push(request);
        return { data: { run_started_at: '2026-10-29T01:00:00Z' } };
      } },
      issues: { listComments, createComment: async request => { posts.push(request); } },
      pulls: { listReviews },
    },
    paginate: async (method, request) => {
      reads.push(request);
      if (method === listReviews) {
        assert.deepEqual(request, { owner: 'owner', repo: 'repo', pull_number: 1995, per_page: 100 });
        return reviews;
      }
      assert.equal(method, listComments);
      assert.deepEqual(request, {
        owner: 'owner', repo: 'repo', issue_number: 1995,
        since: '2026-10-29T01:00:00Z', per_page: 100,
      });
      return comments;
    },
  };
  await execute(github, context, { env: { REVIEW_JOB_RESULT: result, GITHUB_RUN_ATTEMPT: attempt } });
  return { posts, reads };
}

test('terminal reporter runs independently on hosted runner after authorized failure/cancellation', () => {
  assert.match(reporter, /needs: \[gate, review\]/);
  assert.match(reporter, /runs-on: ubuntu-latest/);
  assert.match(reporter, /actions: read/);
  assert.match(reporter, /issues: write/);
  assert.match(reporter, /pull-requests: read/);
  assert.equal(Object.hasOwn(context, 'runAttempt'), false);
  assert.doesNotMatch(reporter, /actions\/checkout|node bin\/|inputs\.prepare-command|steps\.review/);
  for (const allowed of ['true', 'false', '']) {
    for (const result of ['failure', 'cancelled', 'success', 'skipped']) {
      assert.equal(shouldReport(() => true, { gate: { outputs: { allowed } }, review: { result } }),
        allowed === 'true' && ['failure', 'cancelled'].includes(result));
    }
  }
});

for (const result of ['failure', 'cancelled']) {
  test(`hosted reporter posts terminal ${result} without runner logs, artifacts or outputs`, async () => {
    const { posts, reads } = await report({ result });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].issue_number, 1995);
    assert.equal(posts[0].owner, 'owner');
    assert.match(posts[0].body, new RegExp(`status \\*\\*${result}\\*\\*`));
    assert.ok(posts[0].body.includes(runUrl));
    assert.match(posts[0].body, /does not establish whether a verdict was submitted/);
    assert.match(posts[0].body, /codjiflo-job-failure:40601533783:2/);
    assert.deepEqual(reads, [
      { owner: 'owner', repo: 'repo', pull_number: 1995, per_page: 100 },
      { owner: 'owner', repo: 'repo', run_id: context.runId, attempt_number: 2 },
      { owner: 'owner', repo: 'repo', issue_number: 1995, since: '2026-10-29T01:00:00Z', per_page: 100 },
    ]);
  });
}

for (const prefix of ['Codjiflo Reviewer failed;', 'Codjiflo Reviewer preparation failed;']) {
  test(`hosted reporter reconciles existing ${prefix} comment`, async () => {
    const { posts } = await report({ comments: [{ user: bot, body: `${prefix} [Workflow logs](${runUrl})` }] });
    assert.equal(posts.length, 0);
  });
}

test('hosted reporter is idempotent for its run/attempt marker', async () => {
  const { posts } = await report({ comments: [{ user: bot, body: '<!-- codjiflo-job-failure:40601533783:2 -->' }] });
  assert.equal(posts.length, 0);
});

for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
  test(`hosted reporter does not report failure after confirmed ${state} publication`, async () => {
    const { posts, reads } = await report({ reviews: [{ user: bot, state, body: marker }] });
    assert.equal(posts.length, 0);
    assert.deepEqual(reads, [{ owner: 'owner', repo: 'repo', pull_number: 1995, per_page: 100 }]);
  });
}

test('old attempts, pending reviews and user-authored lookalikes do not suppress notification', async () => {
  const { posts } = await report({
    reviews: [
      { user: bot, state: 'APPROVED', body: '<!-- codjiflo-workflow:40601533783:1 -->' },
      { user: bot, state: 'PENDING', body: marker },
      { user: { type: 'User' }, state: 'APPROVED', body: marker },
    ],
    comments: [
      { user: bot, body: '<!-- codjiflo-job-failure:40601533783:1 -->' },
      { user: { type: 'User' }, body: `Codjiflo Reviewer failed; [Workflow logs](${runUrl})` },
      { user: bot, body: 'Codjiflo Reviewer failed; [Workflow logs](https://other.example)' },
    ],
  });
  assert.equal(posts.length, 1);
});

test('reruns use the environment attempt for markers, reconciliation and API requests', async () => {
  const previousComments = [{ user: bot, body: '<!-- codjiflo-job-failure:40601533783:2 -->' }];
  const previousReviews = [{ user: bot, state: 'APPROVED', body: marker }];
  const { posts } = await report({ attempt: '3', comments: previousComments, reviews: previousReviews });
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.includes('<!-- codjiflo-job-failure:40601533783:3 -->'));
  const reconciledComment = await report({
    attempt: '3', comments: [{ user: bot, body: posts[0].body }],
  });
  assert.equal(reconciledComment.posts.length, 0);
  const reconciledReview = await report({
    attempt: '3', reviews: [{ user: bot, state: 'APPROVED', body: '<!-- codjiflo-workflow:40601533783:3 -->' }],
  });
  assert.equal(reconciledReview.posts.length, 0);
  assert.equal(reconciledReview.reads.length, 1);
});

for (const attempt of [undefined, '', '0', '-1', '1.5', 'not-an-attempt', '9007199254740992']) {
  test(`invalid run attempt ${String(attempt)} fails before API requests`, async () => {
    const github = new Proxy({}, {
      get() { assert.fail('invalid run attempts must fail before accessing the GitHub client'); },
    });
    await assert.rejects(
      execute(github, context, { env: { REVIEW_JOB_RESULT: 'failure', GITHUB_RUN_ATTEMPT: attempt } }),
      /GITHUB_RUN_ATTEMPT must be a positive safe integer/,
    );
  });
}
