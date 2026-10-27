import { setTimeout as sleep } from 'node:timers/promises';
import { isApproved, PRESETS } from './commands.mjs';

function validate(envelope, env) {
  const { request, head, base, payload } = envelope ?? {};
  if (envelope?.version !== 1 || !request ||
      !/^[\w.-]+\/[\w.-]+$/.test(request.repo) || !Number.isSafeInteger(request.number) || request.number < 1 ||
      !Object.hasOwn(PRESETS, request.preset) || !['full', 'incremental'].includes(request.mode) ||
      !isApproved(request.requester, env.CODJIFLO_APPROVED_USERS) ||
      !/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base) ||
      payload?.commit_id !== head || !['APPROVE', 'REQUEST_CHANGES'].includes(payload.event) ||
      typeof payload.body !== 'string' || !payload.body.includes('<!-- codjiflo-publication:') ||
      !Array.isArray(payload.comments)) throw new Error('Invalid saved publication or unapproved requester');
  return envelope;
}

function confirmed(receipt, envelope) {
  return Number.isSafeInteger(receipt?.id) && receipt.id > 0 && receipt.commit_id === envelope.head && receipt.body === envelope.payload.body && receipt.state === (envelope.payload.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED');
}

// Reconcile every ambiguous POST before retrying: a transport/5xx error can occur
// after GitHub has already committed the review. A failed GET must never authorize a POST.
export async function publishReview({ envelope, github, env = process.env, delay = sleep }) {
  validate(envelope, env);
  const { request, head, base, payload } = envelope;
  const pullPath = `/repos/${request.repo}/pulls/${request.number}`;
  const reconcile = async () => {
    const match = (await github.list(`${pullPath}/reviews`)).find(receipt => receipt.commit_id === head && receipt.body === payload.body);
    if (match && !confirmed(match, envelope)) throw new Error('Matching GitHub review is not in the expected submitted state; refusing duplicate publication');
    return match;
  };
  const finish = receipt => {
    console.log(`Codjiflo Reviewer publication confirmed: ${receipt.html_url || `https://github.com/${request.repo}/pull/${request.number}#pullrequestreview-${receipt.id}`} (${receipt.state}, ${head})`);
    return receipt;
  };
  const existing = await reconcile();
  if (existing) return finish(existing);
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await github.request(pullPath);
    if (latest.head.sha !== head || latest.base.sha !== base || latest.state !== 'open') throw new Error('Pull request changed during review; refusing stale verdict');
    try {
      const receipt = await github.request(`${pullPath}/reviews`, { method: 'POST', body: payload });
      if (!confirmed(receipt, envelope)) throw new Error('GitHub did not return a confirmed submitted review');
      return finish(receipt);
    } catch (error) {
      const found = await reconcile();
      if (found) return finish(found);
      if (attempt === 2 || !(error instanceof TypeError || error.status >= 500)) throw error;
      await delay(1000 * (attempt + 1));
    }
  }
}

export async function reportPublicationFailure({ request, github, env = process.env, error }) {
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${request.repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  await github.request(`/repos/${request.repo}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer failed; **no successful publication was confirmed**. ${runUrl ? `[Workflow logs](${runUrl})` : 'See process logs.'}\n\n${error.message.slice(0, 1500)}` } }).catch(() => {});
}
