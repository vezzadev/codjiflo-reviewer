import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, isApproved } from './commands.mjs';
import { parseDiff, inlineComment } from './diff.mjs';
import { prompt } from './prompt.mjs';
import { runProcess, runReviewer } from './runner.mjs';

export const MARKER = /<!-- codjiflo-reviewer:v1 (\{[^\n]+\}) -->/;
export function baseline(reviews, base) {
  // A changes-requested review always forces a full review so old blockers are revisited.
  const prior = reviews.filter(review => review.user?.type === 'Bot' && MARKER.test(review.body ?? '')).at(-1);
  if (!prior || prior.state !== 'APPROVED') return null;
  try {
    const value = JSON.parse(MARKER.exec(prior.body)[1]);
    return value.base === base && value.head === prior.commit_id && /^[a-f0-9]{40}$/.test(value.head) ? value : null;
  } catch { return null; }
}

export function validateResult(result, files, cap) {
  if (!result || !['APPROVE', 'REQUEST_CHANGES'].includes(result.verdict) || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.findings) || result.findings.length > cap) throw new Error('Malformed review output');
  for (const finding of result.findings) {
    if (!finding || !['blocking', 'advisory'].includes(finding.disposition) || !['P0', 'P1', 'P2', 'P3'].includes(finding.priority) || typeof finding.title !== 'string' || !finding.title.trim() || typeof finding.body !== 'string' || !finding.body.trim()) throw new Error('Malformed finding');
  }
  if (result.verdict === 'APPROVE' && result.findings.some(finding => finding.disposition === 'blocking')) throw new Error('Approval contradicts blocking findings');
  return result.findings.map(finding => inlineComment(finding, files));
}

export async function review({ request, github, env = process.env, reviewer = runReviewer }) {
  if (!isApproved(request.requester, env.CODJIFLO_APPROVED_USERS)) throw new Error('Review requester is not approved');
  const preset = PRESETS[request.preset];
  if (!Object.hasOwn(PRESETS, request.preset) || !['full', 'incremental'].includes(request.mode)) throw new Error('Unknown preset or review mode');
  const root = `/repos/${request.repo}`;
  const pullPath = `${root}/pulls/${request.number}`;
  const pr = await github.request(pullPath);
  if (pr.state !== 'open') throw new Error('Pull request is not open');
  const head = pr.head.sha;
  const base = pr.base.sha;
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${request.repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  await github.request(`${root}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer starting **${request.preset}** (${request.mode}) at \`${head}\`, requested by @${request.requester}.${runUrl ? `\n\n[Live workflow logs](${runUrl})` : ''}` } });
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-'));
  try {
    const cwd = join(temp, 'repository');
    const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${github.token}`).toString('base64')}` };
    const git = args => runProcess('git', args, { cwd, env: gitEnv });
    await runProcess('git', ['init', cwd], { env: gitEnv });
    await git(['remote', 'add', 'origin', pr.base.repo.clone_url]);
    await git(['fetch', '--no-tags', 'origin', base, head]);
    await git(['checkout', '--detach', head]);
    const mergeBase = (await git(['merge-base', base, head])).trim();
    let scope = mergeBase;
    let mode = 'full';
    let reason = request.mode === 'full' ? 'explicit full review' : 'no usable successful baseline';
    if (request.mode === 'incremental') {
      const previous = baseline(await github.list(`${pullPath}/reviews`), base);
      if (previous) {
        try {
          await git(['fetch', '--no-tags', 'origin', previous.head]);
          if ((await git(['merge-base', previous.head, head])).trim() === previous.head) {
            scope = previous.head; mode = 'incremental'; reason = 'previous approval is an ancestor on the same base';
          } else reason = 'history was rebased';
        } catch { reason = 'previous head is unavailable'; }
      }
    }
    const currentDiff = await git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=3', mergeBase, head]);
    const diff = scope === mergeBase ? currentDiff : await git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=3', scope, head]);
    const result = await reviewer({ preset, prompt: prompt({ level: preset.level, mode, base, head, scope, diff, currentDiff }), cwd, temp, env });
    const comments = validateResult(result, parseDiff(currentDiff), preset.level === 'xhigh' ? 15 : 10);
    // Read immediately before publication. commit_id also pins the native review to the inspected head.
    const latest = await github.request(pullPath);
    if (latest.head.sha !== head || latest.base.sha !== base || latest.state !== 'open') throw new Error('Pull request changed during review; refusing stale verdict');
    const marker = `<!-- codjiflo-reviewer:v1 ${JSON.stringify({ head, base })} -->`;
    return await github.request(`${pullPath}/reviews`, { method: 'POST', body: {
      commit_id: head, event: result.verdict,
      body: `## Codjiflo Reviewer — ${request.preset}\n\n${result.summary}\n\nScope: **${mode}** (${reason}).\n\n${marker}`,
      comments,
    } });
  } catch (error) {
    await github.request(`${root}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer failed; **no review verdict was submitted**. ${runUrl ? `[Workflow logs](${runUrl})` : 'See process logs.'}\n\n${error.message.slice(0, 1500)}` } }).catch(() => {});
    throw error;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
