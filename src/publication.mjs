import { setTimeout as sleep } from 'node:timers/promises';
import { isApproved, PRESETS } from './commands.mjs';
import { secretRedactor } from './redaction.mjs';
import { getCheckpointSnapshot, parseCheckpoint } from './checkpoints.mjs';

// The run belongs to the repository hosting the workflow, not the reviewed one.
export function workflowRunUrl(env) {
  return env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
}

function transient(error) {
  return error instanceof TypeError || error.status >= 500;
}

function publicationId(body) {
  if (typeof body !== 'string') return null;
  // Only the generated final standalone marker is identity; prose may quote it.
  return /(?:^|\n)<!-- codjiflo-publication:([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}) -->[ \t]*(?:\r?\n[ \t]*)*$/.exec(body)?.[1] ?? null;
}

function validate(envelope, env) {
  const { request, head, base, payload, analyzedCheckpoint } = envelope ?? {};
  if (envelope?.version !== 2 || !request ||
      !/^[\w.-]+\/[\w.-]+$/.test(request.repo) || !Number.isSafeInteger(request.number) || request.number < 1 ||
      typeof request.preset !== 'string' || !/^[a-z0-9-]+$/.test(request.preset) || !['full', 'incremental'].includes(request.mode) ||
      !isApproved(request.requester, env.CODJIFLO_APPROVED_USERS) ||
      !/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base) ||
      !analyzedCheckpoint || typeof analyzedCheckpoint !== 'object' || Array.isArray(analyzedCheckpoint) ||
      !(analyzedCheckpoint.fingerprint === null || typeof analyzedCheckpoint.fingerprint === 'string') ||
      !Number.isSafeInteger(analyzedCheckpoint.highestKickoffId) || analyzedCheckpoint.highestKickoffId < 0 ||
      payload?.commit_id !== head || !['APPROVE', 'REQUEST_CHANGES'].includes(payload.event) ||
      !publicationId(payload.body) ||
      !Array.isArray(payload.comments)) throw new Error('Invalid saved publication or unapproved requester');
  validateReviewBody(payload.body);
  return envelope;
}

// Apply the bound to both fresh and recovered envelopes, and again after the
// superseded-review notice is added. Never truncate a persisted findings ledger.
export function validateReviewBody(body) {
  if (typeof body !== 'string' || body.length > 65536 || Buffer.byteLength(body, 'utf8') > 65536) {
    throw new Error('Review body exceeds GitHub limit (65536 characters/UTF-8 bytes); no finding ledger was truncated');
  }
}

const withholdingNotices = {
  APPROVE: '**Approval withheld:** The pull request head or base changed after this review was prepared. This review covers the original commits shown below and is published as a comment, not an approval.',
  REQUEST_CHANGES: '**Change request withheld:** The pull request head or base changed after this review was prepared. This review covers the original commits shown below and is published as a comment, not a change request.',
};

const generationWithholdingNotices = {
  APPROVE: '**Approval withheld:** A newer review generation superseded this review after it was prepared. This review covers the original analysis shown below and is published as a comment, not an approval.',
  REQUEST_CHANGES: '**Change request withheld:** A newer review generation superseded this review after it was prepared. This review covers the original analysis shown below and is published as a comment, not a change request.',
};

function withheldReview(payload, notices) {
  return {
    ...payload,
    event: 'COMMENT',
    body: notices[payload.event] + '\n\n' + payload.body,
  };
}

function confirmed(receipt, envelope, payload = envelope.payload) {
  const notice = payload.body.slice(0, payload.body.indexOf('\n'));
  const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[payload.event];
  return Number.isSafeInteger(receipt?.id) && receipt.id > 0 &&
    receipt.commit_id === envelope.head &&
    publicationId(receipt.body) === publicationId(payload.body) &&
    receipt.state === state &&
    (payload.event !== 'COMMENT' ||
      (receipt.body.startsWith(notice) &&
        /^\r?\n\r?\n/.test(receipt.body.slice(notice.length, notice.length + 4))));
}

// Reconcile ambiguous POSTs immediately and again after backoff before retrying.
// A failed GET never authorizes a POST. Visibility delayed beyond the final read
// can still race a retry; GitHub does not provide an idempotency key for this POST.
export async function publishReview({ envelope, github, env = process.env, delay = sleep }) {
  validate(envelope, env);
  const { request, head, base, payload, analyzedCheckpoint } = envelope;
  const withheld = new Map();
  const downgradedPayload = reason => {
    if (!withheld.has(reason)) withheld.set(reason, withheldReview(payload,
      reason === 'generation' ? generationWithholdingNotices : withholdingNotices));
    return withheld.get(reason);
  };
  const ownGeneration = parseCheckpoint({
    state: payload.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
    commit_id: head, body: payload.body,
  })?.value.kickoffId ?? 0;
  let highestObservedGeneration = analyzedCheckpoint.highestKickoffId;
  let currentCheckpointFingerprint;
  let currentHighestGeneration = 0;
  const pullPath = `/repos/${request.repo}/pulls/${request.number}`;
  const identity = publicationId(payload.body);
  const read = async operation => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (attempt === 2 || !transient(error)) throw error;
        await delay(1000 * (attempt + 1));
      }
    }
  };
  const reconcile = async postError => {
    try {
      const reviews = await read(() => github.list(`${pullPath}/reviews`));
      const checkpointSnapshot = getCheckpointSnapshot(reviews);
      highestObservedGeneration = Math.max(highestObservedGeneration, checkpointSnapshot.highestKickoffId);
      currentCheckpointFingerprint = checkpointSnapshot.fingerprint;
      currentHighestGeneration = checkpointSnapshot.highestKickoffId;
      const matches = reviews.filter(receipt => publicationId(receipt.body) === identity);
      if (matches.length > 1) throw new Error('Multiple GitHub reviews have the publication identity; refusing ambiguous publication');
      const match = matches[0];
      // All outcomes remain valid across recovery and ambiguous POST retries:
      // an earlier attempt may become visible after revision/generation changes.
      if (match && !confirmed(match, envelope)
          && !confirmed(match, envelope, downgradedPayload('revision'))
          && !confirmed(match, envelope, downgradedPayload('generation'))) throw new Error('Matching GitHub review has an invalid identity, head, ID or submitted state; refusing duplicate publication');
      return match;
    } catch (error) {
      if (!postError) throw error;
      throw new AggregateError([postError, error], `Publication failed: ${postError.message}\nReconciliation failed: ${error.message}`, { cause: postError });
    }
  };
  const finish = receipt => {
    console.log(`Codjiflo Reviewer publication confirmed: ${receipt.html_url || `https://github.com/${request.repo}/pull/${request.number}#pullrequestreview-${receipt.id}`} (${receipt.state}, ${head})`);
    return receipt;
  };
  const existing = await reconcile();
  if (existing) return finish(existing);
  let postError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const found = await reconcile(postError);
      if (found) return finish(found);
    }
    // A changed checkpoint or known supersession is safe only as feedback when
    // current history contains a strictly higher generation. A retained high
    // water mark (even with equal null fingerprints) cannot prevent this old
    // ledger becoming the selected checkpoint after history disappears.
    if ((currentCheckpointFingerprint !== analyzedCheckpoint.fingerprint || highestObservedGeneration > ownGeneration)
        && currentHighestGeneration <= ownGeneration) {
      throw new Error('Review checkpoint changed after analysis was prepared; rerun the review before publishing');
    }
    // Recheck revisions immediately before each POST. Generation observations
    // remain monotonic even if later lists lag. These GETs and POST are not atomic.
    const latest = await read(() => github.request(pullPath));
    if (latest.state !== 'open') throw new Error('Pull request is not open; refusing publication');
    const postedPayload = latest.head.sha !== head || latest.base.sha !== base
      ? downgradedPayload('revision')
      : highestObservedGeneration > ownGeneration ? downgradedPayload('generation') : payload;
    validateReviewBody(postedPayload.body);
    try {
      // A direct receipt must confirm the exact event sent by this attempt.
      const receipt = await github.request(`${pullPath}/reviews`, { method: 'POST', body: postedPayload });
      if (!confirmed(receipt, envelope, postedPayload)) throw new Error('GitHub did not return a confirmed submitted review');
      return finish(receipt);
    } catch (error) {
      postError = error;
      const found = await reconcile(error);
      if (found) return finish(found);
      if (attempt === 2 || !transient(error)) throw error;
      await delay(1000 * (attempt + 1));
    }
  }
}

export async function reportPublicationFailure({ request, github, env = process.env, error }) {
  const runUrl = workflowRunUrl(env);
  // Publication credentials stay outside the reviewer environment, so redact at
  // the public sink using the orchestrator's credentials as well as provider ones.
  const { redact } = secretRedactor([github.token, ...Object.entries(env)
    .filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(name))
    .map(([, value]) => value)]);
  const diagnostic = redact(error.message).slice(0, 1500);
  await github.request(`/repos/${request.repo}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer failed; **no successful publication was confirmed**. ${runUrl ? `[Workflow logs](${runUrl})` : 'See process logs.'}\n\n${diagnostic}` } }).catch(() => {});
}
