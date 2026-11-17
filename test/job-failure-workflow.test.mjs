import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8');
const reporter = workflow.slice(workflow.indexOf('  report_failure:\n'));
const condition = reporter.split('\n').find(line => line.trim().startsWith('if:')).trim().slice(4);
const shouldReport = new Function('always', 'needs', `return ${condition};`);
const script = reporter.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('github', 'context', 'process', 'getOctokit', script);
// The run lives in the bot repository; the PR lives in the reviewed one.
const context = {
  serverUrl: 'https://github.example', repo: { owner: 'bot-owner', repo: 'bot-repo' }, runId: 40601533783,
};
const runUrl = `${context.serverUrl}/bot-owner/bot-repo/actions/runs/${context.runId}`;
const marker = `<!-- codjiflo-workflow:${context.runId}:2 -->`;
const bot = { type: 'Bot' };
const concluded = [{ name: 'review', steps: [
  { name: 'Review pull request', status: 'completed', conclusion: 'failure' },
  { name: 'Retain review result', status: 'completed', conclusion: 'success' },
] }];
// Shape GitHub reported for job 133792911342 after its runner went away (issue #51).
const lost = [{ name: 'review', steps: [
  { name: 'Review pull request', status: 'in_progress', conclusion: null },
  { name: 'Retain review result', status: 'pending', conclusion: null },
] }, { name: 'report_failure', steps: [{ name: 'Report unsuccessful review job', status: 'in_progress', conclusion: null }] }];

async function report({
  comments = [], reviews = [], result = 'failure', attempt = '2', jobs = concluded, redispatchOf = '',
} = {}) {
  const posts = [];
  const reads = [];
  const dispatches = [];
  const listComments = () => {};
  const listReviews = () => {};
  const github = {
    rest: {
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
  const listJobsForWorkflowRunAttempt = () => {};
  const getOctokit = token => {
    assert.equal(token, 'actions-token');
    return {
      rest: { actions: {
        listJobsForWorkflowRunAttempt,
        createWorkflowDispatch: async request => {
          // The comment must not claim a retry that GitHub refused.
          assert.equal(posts.length, 0);
          dispatches.push(request);
        },
      } },
      paginate: async (method, request) => {
        assert.equal(method, listJobsForWorkflowRunAttempt);
        assert.deepEqual(request, {
          owner: 'bot-owner', repo: 'bot-repo', run_id: 40601533783, attempt_number: Number(attempt), per_page: 100,
        });
        return jobs;
      },
    };
  };
  await execute(github, context, { env: {
    REVIEW_JOB_RESULT: result, GITHUB_RUN_ATTEMPT: attempt,
    TARGET_REPOSITORY: 'owner/repo', TARGET_PR: '1995', ATTEMPT_STARTED_AT: '2026-10-29T01:00:00Z',
    COMMENT_ID: '6936926881', REDISPATCH_OF: redispatchOf, WORKFLOW_REF: 'main', ACTIONS_TOKEN: 'actions-token',
  } }, getOctokit);
  return { posts, reads, dispatches };
}

test('terminal reporter runs independently on hosted runner after authorized failure/cancellation', () => {
  assert.match(reporter, /needs: \[gate, review\]/);
  assert.match(reporter, /runs-on: ubuntu-latest/);
  assert.match(reporter, /actions: write/);
  assert.equal(Object.hasOwn(context, 'runAttempt'), false);
  assert.doesNotMatch(reporter, /actions\/checkout|node bin\/|steps\.review/);
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

for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']) {
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
      { user: bot, state: 'COMMENTED', body: '<!-- codjiflo-workflow:40601533783:1 -->' },
      { user: bot, state: 'PENDING', body: marker },
      { user: { type: 'User' }, state: 'APPROVED', body: marker },
      { user: { type: 'User' }, state: 'COMMENTED', body: marker },
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

test('an unread attempt start time fails before API requests instead of widening reconciliation', async () => {
  const github = new Proxy({}, {
    get() { assert.fail('a missing start time must fail before accessing the GitHub client'); },
  });
  await assert.rejects(
    execute(github, context, { env: { REVIEW_JOB_RESULT: 'failure', GITHUB_RUN_ATTEMPT: '2', TARGET_REPOSITORY: 'owner/repo', TARGET_PR: '1995', ATTEMPT_STARTED_AT: '' } }),
    /ATTEMPT_STARTED_AT must be a timestamp/,
  );
});

test('a runner lost mid-review re-dispatches the same comment once before reporting the retry', async () => {
  const { posts, dispatches } = await report({ jobs: lost });
  assert.deepEqual(dispatches, [{
    owner: 'bot-owner', repo: 'bot-repo', workflow_id: 'review.yml', ref: 'main',
    inputs: { repository: 'owner/repo', 'comment-id': '6936926881', 'redispatch-of': '40601533783' },
  }]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /lost its runner mid-review/);
  assert.ok(posts[0].body.includes(runUrl));
  assert.match(posts[0].body, /codjiflo-job-failure:40601533783:2/);
  // The posted notice marks this attempt handled, so a duplicate reporter pass cannot dispatch again.
  const rerun = await report({ jobs: lost, comments: [{ user: bot, body: posts[0].body }] });
  assert.deepEqual([rerun.posts, rerun.dispatches], [[], []]);
});

test('lost-runner retry is skipped when the attempt already published a verdict', async () => {
  const { posts, dispatches } = await report({ jobs: lost, reviews: [{ user: bot, state: 'APPROVED', body: marker }] });
  assert.deepEqual([posts, dispatches], [[], []]);
});

for (const [label, options] of [
  ['a retry whose runner is lost again', { jobs: lost, redispatchOf: '40601533700' }],
  ['a failure the runner concluded', { jobs: concluded }],
  ['a cancellation', { jobs: lost, result: 'cancelled' }],
]) {
  test(`${label} reports without re-dispatching`, async () => {
    const { posts, dispatches } = await report(options);
    assert.equal(dispatches.length, 0);
    assert.equal(posts.length, 1);
    assert.match(posts[0].body, /does not establish whether a verdict was submitted/);
  });
}
