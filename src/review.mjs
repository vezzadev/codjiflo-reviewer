import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, isApproved } from './commands.mjs';
import { filesFromApi, inlineComment } from './diff.mjs';
import { prompt } from './prompt.mjs';
import { runProcess, runReviewer } from './runner.mjs';

export const MARKER = /<!-- codjiflo-reviewer:v2 (\{[^\n]+\}) -->/;
export function baseline(reviews, base, preset) {
  // The latest marked review governs, including PAT-authored blockers.
  const prior = reviews.filter(review => MARKER.test(review.body ?? '')).at(-1);
  if (!prior || prior.state !== 'APPROVED') return null;
  try {
    const value = JSON.parse(MARKER.exec(prior.body)[1]);
    return value.base === base && value.preset === preset && value.head === prior.commit_id && /^[a-f0-9]{40}$/.test(value.head) ? value : null;
  } catch { return null; }
}

export function validateResult(result, files, cap) {
  if (!result || !['APPROVE', 'REQUEST_CHANGES'].includes(result.verdict) || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.findings) || result.findings.length > cap) throw new Error('Malformed review output');
  for (const finding of result.findings) {
    if (!finding || !['blocking', 'advisory'].includes(finding.disposition) || !['P0', 'P1', 'P2', 'P3'].includes(finding.priority) || typeof finding.title !== 'string' || !finding.title.trim() || typeof finding.body !== 'string' || !finding.body.trim()) throw new Error('Malformed finding');
  }
  if (result.verdict === 'APPROVE' && result.findings.some(finding => finding.disposition === 'blocking')) throw new Error('Approval contradicts blocking findings');
  const comments = [];
  for (const finding of result.findings) {
    try { comments.push(inlineComment(finding, files)); }
    catch {
      result.verdict = 'REQUEST_CHANGES';
      result.summary += `\n\n**[${finding.priority}] ${finding.title}** (${finding.path}, unanchorable in the current PR diff)\n\n${finding.body}`;
    }
  }
  return comments;
}

// Walk Git objects, never the worktree: even an ancestor can be a host symlink.
async function supplementalPromptBlob(git, revision) {
  const parts = ['.codjiflo', 'code-review', 'PROMPT.md'];
  let tree = revision;
  for (const [index, name] of parts.entries()) {
    const entry = await git(['ls-tree', '-z', tree, '--', name]);
    if (!entry) return undefined;
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
    const leaf = index === parts.length - 1;
    if (!match || match[4] !== name || (leaf ? !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' : match[1] !== '040000' || match[2] !== 'tree')) {
      throw new Error('Repository supplemental prompt must be a regular Git blob with tree-only ancestors; links, directories, and submodules are not allowed');
    }
    if (leaf) return match[3];
    tree = match[3];
  }
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
    const git = args => runProcess('git', args, { cwd, env: gitEnv, timeoutMs: 5 * 60 * 1000 });
    await runProcess('git', ['init', cwd], { env: gitEnv, timeoutMs: 5 * 60 * 1000 });
    await git(['remote', 'add', 'origin', pr.base.repo.clone_url]);
    await git(['fetch', '--no-tags', 'origin', base, head]);
    await git(['checkout', '--detach', head]);
    const mergeBase = (await git(['merge-base', base, head])).trim();
    const currentPromptBlob = await supplementalPromptBlob(git, head);
    let scope = mergeBase;
    let mode = 'full';
    let reason = request.mode === 'full' ? 'explicit full review' : 'no usable successful baseline';
    if (request.mode === 'incremental') {
      const previous = baseline(await github.list(`${pullPath}/reviews`), base, request.preset);
      if (previous && previous.head !== head) {
        try {
          await git(['fetch', '--no-tags', 'origin', previous.head]);
          if ((await git(['merge-base', previous.head, head])).trim() === previous.head) {
            if (await supplementalPromptBlob(git, previous.head) !== currentPromptBlob) {
              reason = 'repository supplemental instructions changed since the previous approval';
            } else {
              scope = previous.head; mode = 'incremental'; reason = 'previous approval is an ancestor on the same base';
            }
          } else reason = 'history was rebased';
        } catch { reason = 'previous head is unavailable'; }
      } else if (previous) reason = 'head is unchanged; reviewing the full PR again';
    }
    if (!Number.isInteger(pr.changed_files) || pr.changed_files > 3000) throw new Error('Cannot obtain complete PR file metadata (GitHub files API limit: 3000)');
    const metadata = await github.list(`${pullPath}/files`);
    if (metadata.length !== pr.changed_files || new Set(metadata.map(file => file.filename)).size !== metadata.length) throw new Error('Incomplete PR file metadata');
    const files = filesFromApi(metadata);
    const diff = await git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', scope, head]);
    const currentDiff = JSON.stringify([...files.values()].map(file => ({ filename: file.path, previous_filename: file.previousPath, patch: file.patch })), null, 2);
    const customInstructions = currentPromptBlob === undefined ? undefined : await git(['cat-file', 'blob', currentPromptBlob]);
    const result = await reviewer({ preset, prompt: prompt({ level: preset.level, mode, base, head, scope, diff, currentDiff, customInstructions }), cwd, temp, env });
    const comments = validateResult(result, files, preset.level === 'xhigh' ? 15 : 10);
    // Read immediately before publication. commit_id also pins the native review to the inspected head.
    const latest = await github.request(pullPath);
    if (latest.head.sha !== head || latest.base.sha !== base || latest.state !== 'open') throw new Error('Pull request changed during review; refusing stale verdict');
    const marker = `<!-- codjiflo-reviewer:v2 ${JSON.stringify({ head, base, preset: request.preset })} -->`;
    return await github.request(`${pullPath}/reviews`, { method: 'POST', body: {
      commit_id: head, event: result.verdict,
      body: `## Codjiflo Reviewer — ${request.preset}\n\n${result.summary}\n\nScope: **${mode}** (${reason}).\n\n${marker}`,
      comments,
    } });
  } catch (error) {
    await github.request(`${root}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer failed; **no successful publication was confirmed**. ${runUrl ? `[Workflow logs](${runUrl})` : 'See process logs.'}\n\n${error.message.slice(0, 1500)}` } }).catch(() => {});
    throw error;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
