import { setTimeout as sleep } from 'node:timers/promises';
import { isApproved, PRESETS } from './commands.mjs';

export function workflowRunUrl(request, env) {
  return env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${request.repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
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
  const { request, head, base, payload } = envelope ?? {};
  if (envelope?.version !== 1 || !request ||
      !/^[\w.-]+\/[\w.-]+$/.test(request.repo) || !Number.isSafeInteger(request.number) || request.number < 1 ||
      !Object.hasOwn(PRESETS, request.preset) || !['full', 'incremental'].includes(request.mode) ||
      !isApproved(request.requester, env.CODJIFLO_APPROVED_USERS) ||
      !/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base) ||
      payload?.commit_id !== head || !['APPROVE', 'REQUEST_CHANGES'].includes(payload.event) ||
      !publicationId(payload.body) ||
      !Array.isArray(payload.comments)) throw new Error('Invalid saved publication or unapproved requester');
  return envelope;
}

function confirmed(receipt, envelope) {
  return Number.isSafeInteger(receipt?.id) && receipt.id > 0 && receipt.commit_id === envelope.head && publicationId(receipt.body) === publicationId(envelope.payload.body) && receipt.state === (envelope.payload.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED');
}

// Reconcile ambiguous POSTs immediately and again after backoff before retrying.
// A failed GET never authorizes a POST. Visibility delayed beyond the final read
// can still race a retry; GitHub does not provide an idempotency key for this POST.
export async function publishReview({ envelope, github, env = process.env, delay = sleep }) {
  validate(envelope, env);
  const { request, head, base, payload } = envelope;
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
      const matches = (await read(() => github.list(`${pullPath}/reviews`))).filter(receipt =>
        publicationId(receipt.body) === identity);
      if (matches.length > 1) throw new Error('Multiple GitHub reviews have the publication identity; refusing ambiguous publication');
      const match = matches[0];
      if (match && !confirmed(match, envelope)) throw new Error('Matching GitHub review has an invalid identity, head, ID or submitted state; refusing duplicate publication');
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
    const latest = await read(() => github.request(pullPath));
    if (latest.head.sha !== head || latest.base.sha !== base || latest.state !== 'open') throw new Error('Pull request changed during review; refusing stale verdict');
    try {
      const receipt = await github.request(`${pullPath}/reviews`, { method: 'POST', body: payload });
      if (!confirmed(receipt, envelope)) throw new Error('GitHub did not return a confirmed submitted review');
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
  const runUrl = workflowRunUrl(request, env);
  await github.request(`/repos/${request.repo}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer failed; **no successful publication was confirmed**. ${runUrl ? `[Workflow logs](${runUrl})` : 'See process logs.'}\n\n${error.message.slice(0, 1500)}` } }).catch(() => {});
}
