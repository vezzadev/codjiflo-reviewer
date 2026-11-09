import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRESETS, isApproved } from './commands.mjs';
import { filesFromApi, inlineComment } from './diff.mjs';
import { reviewInput } from './evidence.mjs';
import { runProcess, runReviewer } from './runner.mjs';
import { publishReview, reportPublicationFailure, workflowRunUrl, validateReviewBody } from './publication.mjs';
import { sanitizeGitEnv } from './git-environment.mjs';
import { FINDING_FIELDS, validFinding, latestCheckpoint, getCheckpointSnapshot } from './checkpoints.mjs';

export function outstandingFindings(reviews) {
  return latestCheckpoint(reviews)?.value.findings ?? [];
}

function checkpointFallbackReason(checkpoint, base, preset) {
  const unavailable = 'no usable v4 review checkpoint';
  if (!checkpoint || !['APPROVED', 'CHANGES_REQUESTED'].includes(checkpoint.prior.state)) return unavailable;
  const { value } = checkpoint;
  const cap = PRESETS[value.preset].level === 'xhigh' ? 15 : 10;
  let count = 0;
  for (const finding of value.findings) {
    // Same-head carried findings conservatively count too: capped analyses
    // cannot establish that the unchanged scope has no further findings.
    if (finding.originHead === value.head && ++count >= cap) return 'previous review reached the new-findings cap';
  }
  return value.base === base && value.preset === preset ? null : unavailable;
}

export function baseline(reviews, base, preset) {
  const checkpoint = latestCheckpoint(reviews);
  return checkpointFallbackReason(checkpoint, base, preset) === null ? checkpoint.value : null;
}

export function validateResult(result, files, cap, priorFindings = []) {
  if (result?.verdict === 'INCOMPLETE') {
    throw new Error('Review incomplete; no defect verdict. Required analysis could not be completed. See provider logs for details.');
  }
  if (!result || !['APPROVE', 'REQUEST_CHANGES'].includes(result.verdict) || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.findings) || result.findings.length > cap || !Array.isArray(result.resolutions)) throw new Error('Malformed review output');
  for (const finding of result.findings) {
    if (!validFinding(finding) || Object.keys(finding).sort().join() !== [...FINDING_FIELDS].sort().join()) throw new Error('Malformed finding');
  }
  const priorIds = new Set(priorFindings.map(finding => finding.id));
  const resolutions = new Map();
  for (const resolution of result.resolutions) {
    if (!resolution || Object.keys(resolution).sort().join() !== 'id,reason,status'
        || !priorIds.has(resolution.id) || resolutions.has(resolution.id)
        || !['resolved', 'unresolved'].includes(resolution.status)
        || typeof resolution.reason !== 'string' || !resolution.reason.trim()) throw new Error('Malformed finding resolutions');
    resolutions.set(resolution.id, resolution);
  }
  if (resolutions.size !== priorIds.size) throw new Error('Finding resolutions must cover every prior finding exactly once');
  const carried = priorFindings.filter(finding => resolutions.get(finding.id).status === 'unresolved');
  const blockers = [...result.findings, ...carried].some(finding => finding.disposition === 'blocking');
  if (result.verdict === 'APPROVE' && blockers) throw new Error('Approval contradicts blocking findings');
  if (result.verdict === 'REQUEST_CHANGES' && !blockers) {
    throw new Error('Changes request has no blocking defect findings; refusing a defect verdict');
  }
  for (const finding of carried) {
    result.summary += `\n\n### Outstanding [${finding.priority}] ${finding.title} (${finding.disposition})\n\nFinding ID: \`${finding.id}\`\nOriginal commit: \`${finding.originHead}\`\nOriginal location: \`${finding.path}\` (${finding.side} ${finding.start_line}-${finding.line})\n\n${finding.body}\n\nCurrent assessment: ${resolutions.get(finding.id).reason}`;
  }
  const comments = [];
  for (const finding of result.findings) {
    try { comments.push(inlineComment(finding, files)); }
    catch {
      result.summary += `\n\n**[${finding.priority}] ${finding.title}** (${finding.path}, unanchorable in the current PR diff)\n\n${finding.body}`;
    }
  }
  return comments;
}

// Walk Git objects, never the worktree: even an ancestor can be a host symlink.
async function repositoryPromptBlob(git, revision) {
  const parts = ['.codjiflo', 'code-review', 'PROMPT.md'];
  let tree = revision;
  for (const [index, name] of parts.entries()) {
    const entry = await git(['ls-tree', '-z', tree, '--', name]);
    if (!entry) return undefined;
    const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
    const leaf = index === parts.length - 1;
    if (!match || match[4] !== name || (leaf ? !['100644', '100755'].includes(match[1]) || match[2] !== 'blob' : match[1] !== '040000' || match[2] !== 'tree')) {
      throw new Error('Repository review prompt must be a regular Git blob with tree-only ancestors; links, directories, and submodules are not allowed');
    }
    if (leaf) return match[3];
    tree = match[3];
  }
}

function sourceSubmodules(value = '[]') {
  let paths;
  try { paths = JSON.parse(value); }
  catch { throw new Error('CODJIFLO_SOURCE_SUBMODULES must be a JSON array of exact safe relative gitlink paths'); }
  if (!Array.isArray(paths) || paths.some(path =>
    typeof path !== 'string' || !path || /[\\:\x00-\x1f\x7f]/.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))) {
    throw new Error('CODJIFLO_SOURCE_SUBMODULES must be a JSON array of exact safe relative gitlink paths');
  }
  return [...new Set(paths)];
}

export async function review({ request, github, env = process.env, reviewer = runReviewer, output = env.CODJIFLO_RESULT_PATH || undefined }) {
  if (!isApproved(request.requester, env.CODJIFLO_APPROVED_USERS)) throw new Error('Review requester is not approved');
  const preset = PRESETS[request.preset];
  if (!Object.hasOwn(PRESETS, request.preset) || !['full', 'incremental'].includes(request.mode)) throw new Error('Unknown preset or review mode');
  const root = `/repos/${request.repo}`;
  const pullPath = `${root}/pulls/${request.number}`;
  const pr = await github.request(pullPath);
  if (pr.state !== 'open') throw new Error('Pull request is not open');
  const head = pr.head.sha;
  const base = pr.base.sha;
  const runUrl = workflowRunUrl(request, env);
  const kickoff = await github.request(`${root}/issues/${request.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer starting **${request.preset}** (${request.mode}) at \`${head}\`, requested by @${request.requester}.${runUrl ? `\n\n[Live workflow logs](${runUrl})` : ''}` } });
  const kickoffId = kickoff?.id;
  if (!Number.isSafeInteger(kickoffId) || kickoffId <= 0) throw new Error('Kickoff comment response must include a positive safe-integer id');
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-'));
  try {
    const dependencies = sourceSubmodules(env.CODJIFLO_SOURCE_SUBMODULES);
    const cwd = join(temp, 'repository');
    const reviewEnv = sanitizeGitEnv(env);
    const gitEnv = { ...reviewEnv, GIT_TERMINAL_PROMPT: '0' };
    const cloneUrl = pr.base.repo.clone_url;
    // Submodule processes inherit this environment. Only HTTP(S) clones need
    // the GitHub header, and it must not follow a submodule to another origin.
    // File and SSH transports have no HTTP origin (SCP-style SSH is not a URL).
    if (/^https?:\/\//i.test(cloneUrl)) {
      const { origin } = new URL(cloneUrl);
      Object.assign(gitEnv, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${github.token}`).toString('base64')}`,
      });
    }
    for (const name of Object.keys(reviewEnv)) {
      if (['GITHUB_TOKEN', 'GH_TOKEN'].includes(name.toUpperCase())) delete reviewEnv[name];
    }
    const git = args => runProcess('git', args, { cwd, env: gitEnv, timeoutMs: 5 * 60 * 1000 });
    await runProcess('git', ['init', cwd], { env: gitEnv, timeoutMs: 5 * 60 * 1000 });
    await git(['remote', 'add', 'origin', cloneUrl]);
    await git(['fetch', '--no-tags', 'origin', base, head]);
    await git(['checkout', '--detach', head]);
    const mergeBase = (await git(['merge-base', base, head])).trim();
    const currentPromptBlob = await repositoryPromptBlob(git, head);
    if (dependencies.length) {
      const entries = (await git(['--literal-pathspecs', 'ls-tree', '-r', '-z', head, '--', ...dependencies])).split('\0');
      const gitlinks = new Set(entries.filter(entry => entry.startsWith('160000 commit ')).map(entry => entry.slice(entry.indexOf('\t') + 1)));
      for (const path of dependencies) {
        if (!gitlinks.has(path)) throw new Error(`Source submodule is not an exact gitlink path at the inspected head: ${JSON.stringify(path)}`);
      }
      // Literal pathspecs prevent a valid gitlink named e.g. sdk[1] from
      // selecting other dependencies. Descendants use their pinned gitlinks.
      await git(['--literal-pathspecs', 'submodule', 'update', '--init', '--recursive', '--checkout', '--', ...dependencies]);
    }
    const reviews = await github.list(`${pullPath}/reviews`);
    const checkpoint = latestCheckpoint(reviews);
    const analyzedCheckpoint = getCheckpointSnapshot(reviews);
    const priorFindings = checkpoint?.value.findings ?? [];
    let scope = mergeBase;
    let mode = 'full';
    let reason = request.mode === 'full' ? 'explicit full review' : 'no usable v4 review checkpoint';
    if (request.mode === 'incremental') {
      const fallbackReason = checkpointFallbackReason(checkpoint, base, request.preset);
      const previous = fallbackReason === null ? checkpoint.value : null;
      if (fallbackReason) reason = fallbackReason;
      if (previous && previous.head !== head) {
        try {
          await git(['fetch', '--no-tags', 'origin', previous.head]);
          if ((await git(['merge-base', previous.head, head])).trim() === previous.head) {
            if (await repositoryPromptBlob(git, previous.head) !== currentPromptBlob) {
              reason = 'repository review instructions changed since the previous completed review';
            } else {
              scope = previous.head; mode = 'incremental'; reason = 'previous completed review is an ancestor on the same base';
            }
          } else reason = 'history was rebased';
        } catch { reason = 'previous head is unavailable'; }
      } else if (previous) reason = 'head is unchanged; reviewing the full PR again';
    }
    if (!Number.isInteger(pr.changed_files) || pr.changed_files > 3000) throw new Error('Cannot obtain complete PR file metadata (GitHub files API limit: 3000)');
    const metadata = await github.list(`${pullPath}/files`);
    // The files endpoint follows the live PR, unlike our pinned Git objects.
    // Bracket its paginated snapshot before spending a model invocation.
    const snapshot = await github.request(pullPath);
    if (snapshot.state !== 'open') throw new Error('Pull request is not open');
    if (snapshot.head.sha !== head || snapshot.base.sha !== base) {
      throw new Error('Pull request changed while collecting file metadata; request a new review');
    }
    if (metadata.length !== pr.changed_files || new Set(metadata.map(file => file.filename)).size !== metadata.length) throw new Error('Incomplete PR file metadata');
    const files = filesFromApi(metadata);
    const diff = await git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', scope, head, '--']);
    const currentDiff = JSON.stringify([...files.values()].map(file => ({ filename: file.path, previous_filename: file.previousPath, patch: file.patch })), null, 2);
    const customInstructions = currentPromptBlob === undefined ? undefined : await git(['cat-file', 'blob', currentPromptBlob]);
    const input = await reviewInput({ preset, options: { level: preset.level, mode, base, head, scope, diff, currentDiff, customInstructions, priorFindings }, cwd, temp, git });
    const result = await reviewer({ preset, prompt: input, cwd, temp, env: reviewEnv });
    const comments = validateResult(result, files, preset.level === 'xhigh' ? 15 : 10, priorFindings);
    const publication = randomUUID();
    const resultPath = output ?? `codjiflo-result-${publication}.json`;
    const unresolved = new Set(result.resolutions.filter(resolution => resolution.status === 'unresolved').map(resolution => resolution.id));
    const findings = [
      ...priorFindings.filter(finding => unresolved.has(finding.id)),
      ...result.findings.map(finding => ({ id: randomUUID(), originHead: head, ...finding })),
    ];
    const marker = `<!-- codjiflo-reviewer:v4 ${JSON.stringify({ head, base, kickoffId, preset: request.preset, findings }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')} -->`;
    const workflowMarker = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ?
      `\n<!-- codjiflo-workflow:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT} -->` : '';
    const envelope = { version: 2, request, head, base, analyzedCheckpoint, payload: {
      commit_id: head, event: result.verdict,
      body: `## Codjiflo Reviewer — ${request.preset}\n\n${result.summary}\n\nReviewed range: \`${scope}..${head}\`\nPR base snapshot: \`${base}\`\n\nScope: **${mode}** (${reason}).\n\n${marker}${workflowMarker}\n<!-- codjiflo-publication:${publication} -->`,
      comments,
    } };
    validateReviewBody(envelope.payload.body);
    await writeFile(resultPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, ...(output === undefined ? { flag: 'wx' } : {}) });
    console.log(`Validated review retained at ${resultPath}`);
    return await publishReview({ envelope, github, env });
  } catch (error) {
    await reportPublicationFailure({ request, github, env, error });
    throw error;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
