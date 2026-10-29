import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../src/runner.mjs';
import { sanitizeGitEnv } from '../src/git-environment.mjs';

export async function isolatedGitEnv(temp, inherited = process.env) {
  const home = join(temp, 'home');
  const xdg = join(home, '.config');
  await mkdir(xdg, { recursive: true, mode: 0o700 });
  const gitConfig = join(home, '.gitconfig');
  await writeFile(gitConfig, '');
  const env = sanitizeGitEnv(inherited);
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
}

async function setHeadPrompt({ repo, temp, promptPath, hostPromptDirectory, hostPrompt, headPrompt, headPromptType }) {
  if (headPrompt === undefined && headPromptType === 'file') return;
  await rm(join(repo, '.codjiflo'), { recursive: true, force: true });
  if (headPromptType === 'ancestor-symlink') {
    await symlink(join(temp, 'host'), join(repo, '.codjiflo'));
    return;
  }
  await mkdir(join(repo, '.codjiflo'));
  if (headPromptType === 'parent-symlink') {
    await symlink(hostPromptDirectory, join(repo, '.codjiflo', 'code-review'));
    return;
  }
  await mkdir(join(repo, '.codjiflo', 'code-review'));
  if (headPromptType === 'directory') {
    await mkdir(promptPath);
    await writeFile(join(promptPath, 'keep'), 'This tracked directory cannot be read as a prompt.');
    return;
  }
  if (headPromptType === 'symlink') {
    await symlink(hostPrompt, promptPath);
    return;
  }
  if (headPromptType === 'file' && headPrompt !== null) await writeFile(promptPath, headPrompt);
}

export async function fixture({ filename = 'a.js', previousFilename = filename, oldLine = 'old', newLine = 'new', basePrompt, headPrompt, headPromptType = 'file' } = {}) {
  if (!['file', 'directory', 'symlink', 'parent-symlink', 'ancestor-symlink', 'submodule'].includes(headPromptType)) throw new Error(`Unknown head prompt type: ${headPromptType}`);
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-fixture-'));
  const repo = join(temp, 'repo');
  await mkdir(repo);
  const env = await isolatedGitEnv(temp);
  const git = args => runProcess('git', args, { cwd: repo, env });
  await git(['init', '-b', 'main']);
  const tail = 'context\n'.repeat(8);
  await writeFile(join(repo, previousFilename), `${oldLine}\nsecond\n${tail}`);
  const promptPath = join(repo, '.codjiflo', 'code-review', 'PROMPT.md');
  if (basePrompt !== undefined) {
    await mkdir(join(repo, '.codjiflo', 'code-review'), { recursive: true });
    await writeFile(promptPath, basePrompt);
  }
  await git(['add', '.']); await git(['commit', '-m', 'base']);
  const base = (await git(['rev-parse', 'HEAD'])).trim();
  if (filename !== previousFilename) await git(['mv', previousFilename, filename]);
  await writeFile(join(repo, filename), `${newLine}\nsecond\n${tail}`);
  await git(['commit', '-am', 'first']);
  const previous = (await git(['rev-parse', 'HEAD'])).trim();
  await writeFile(join(repo, filename), `${newLine}\nchanged\n${tail}`);
  const hostSentinel = 'HOST-ONLY-SENTINEL-résumé-秘密';
  const hostPromptDirectory = join(temp, 'host', 'code-review');
  await mkdir(hostPromptDirectory, { recursive: true });
  const hostPrompt = join(hostPromptDirectory, 'PROMPT.md');
  await writeFile(hostPrompt, hostSentinel);
  await setHeadPrompt({ repo, temp, promptPath, hostPromptDirectory, hostPrompt, headPrompt, headPromptType });
  await git(['add', '.']);
  if (headPromptType === 'submodule') await git(['update-index', '--add', '--cacheinfo', `160000,${base},.codjiflo/code-review/PROMPT.md`]);
  await git(['commit', '-m', 'second']);
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const diffArgs = ['diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', base, head];
  const localDiff = await git(['-c', 'core.quotePath=false', ...diffArgs]);
  const fileDiff = await git(['-c', 'core.quotePath=false', ...diffArgs, '--', previousFilename, filename]);
  const patch = fileDiff.slice(fileDiff.indexOf('@@ ')).replace(/\n$/, '');
  const files = [{ filename, ...(filename !== previousFilename ? { previous_filename: previousFilename } : {}), status: filename === previousFilename ? 'modified' : 'renamed', additions: patch.split('\n').filter(line => line.startsWith('+')).length, deletions: patch.split('\n').filter(line => line.startsWith('-')).length, patch }];
  // Keep the primary file's synthetic rename/patch behavior used by coordinate tests.
  // Repository prompt paths must still appear in the authoritative full-PR API metadata.
  const changes = (await git(['diff', '--find-renames', '--name-status', '-z', base, head])).split('\0');
  for (let index = 0; index < changes.length - 1;) {
    const status = changes[index++];
    const oldPath = changes[index++];
    const newPath = /^[RC]/.test(status) ? changes[index++] : oldPath;
    if (newPath === filename || oldPath === previousFilename) continue;
    const fileDiff = await git(['-c', 'core.quotePath=false', ...diffArgs, '--', oldPath, ...(newPath === oldPath ? [] : [newPath])]);
    const patchStart = fileDiff.indexOf('@@ ');
    const patch = patchStart === -1 ? '' : fileDiff.slice(patchStart).replace(/\n$/, '');
    files.push({
      filename: newPath,
      ...(/^R/.test(status) ? { previous_filename: oldPath } : {}),
      status: ({ A: 'added', D: 'removed', R: 'renamed', C: 'copied' })[status[0]] ?? 'modified',
      additions: patch.split('\n').filter(line => line.startsWith('+')).length,
      deletions: patch.split('\n').filter(line => line.startsWith('-')).length,
      patch,
    });
  }
  const fake = join(temp, 'fake-cli.mjs');
  const capture = join(temp, 'prompt.txt');
  await writeFile(fake, `#!/usr/bin/env node
import { writeFile, cp } from 'node:fs/promises';
process.stdin.setEncoding('utf8');
let input = ''; for await (const chunk of process.stdin) input += chunk;
await writeFile(process.env.FIXTURE_CAPTURE + '.stdin', input);
await writeFile(process.env.FIXTURE_CAPTURE + '.cwd', process.cwd(), 'utf8');
if (process.env.FIXTURE_INSPECT_GIT === '1') {
 const { execFileSync } = await import('node:child_process');
 await writeFile(process.env.FIXTURE_CAPTURE + '.git-context', JSON.stringify({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim(),
  config: execFileSync('git', ['config', '--list', '--show-origin'], { encoding: 'utf8', timeout: 10000 }),
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:GIT_|GITHUB_TOKEN$|GH_TOKEN$|OPENAI_API_KEY$)/i.test(name))),
 }));
}
const manifestLine = input.split('\\n').find(line => line.startsWith('Navigable review evidence manifest: '));
if (manifestLine) {
 const manifest = JSON.parse(manifestLine.slice('Navigable review evidence manifest: '.length));
 // Capture full evidence without pretending the fake CLI analyzed it.
 await cp(manifest.directory, process.env.FIXTURE_CAPTURE + '.evidence', { recursive: true, force: true });
}
await writeFile(process.env.FIXTURE_CAPTURE, input);
console.log(JSON.stringify({type:'agent_start'}));
process.stderr.write('fixture stderr streaming live\\n');
if (process.env.FIXTURE_MODE === 'failure') process.exit(9);
if (process.env.FIXTURE_MODE === 'publication-secret-failure') {
 // Fake publication credentials are intentionally embedded, not inherited by
 // this reviewer. Model/tool access can supply diagnostics from outside env.
 console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',stopReason:'error',errorMessage:'Fixture publication diagnostic github=fixture-token-not-real gh=fixture-gh-token-not-real mixed=fixture-mixed-token-not-real provider=' + process.env.OPENAI_API_KEY}]}));
 process.exit(1);
}
const findings = process.env.FIXTURE_MODE === 'findings' ? [
 {path:'a.js',side:'LEFT',start_line:1,line:1,priority:'P1',disposition:'blocking',title:'Old-side bug',body:'Concrete failure scenario.'},
 {path:'a.js',side:'RIGHT',start_line:1,line:2,priority:'P2',disposition:'blocking',title:'Range bug',body:'Concrete failure scenario.'}
] : [];
const result = process.env.FIXTURE_MODE === 'incomplete-input'
 ? {verdict:'INCOMPLETE',summary:'A required review scope range could not be processed.',findings:[]}
 : {verdict: findings.length ? 'REQUEST_CHANGES' : 'APPROVE',summary:'Fixture review complete.',findings};
const emit = event => console.log(JSON.stringify(event));
const mode = process.env.FIXTURE_MODE;
if (mode === 'raw-exit') {
 console.log('RAW-STDOUT-SECRET-do-not-publish');
 process.stderr.write('STDERR-HOST-SECRET-do-not-publish'.repeat(100));
 process.exit(7);
}
if (mode === 'non-json-completed') console.log('BANNER-SECRET-do-not-publish');
if (mode === 'truncated') {
 process.stdout.write('{"type":"tool_execution_start"');
 process.exit(0);
}
if (mode !== 'missing-result') {
 emit({type:'tool_execution_start',toolName:'final_review',toolCallId:'review-1',args:mode === 'malformed' ? {verdict:'APPROVE'} : result});
 if (mode === 'duplicate-result') emit({type:'tool_execution_start',toolName:'final_review',toolCallId:'review-2',args:result});
 if (mode !== 'missing-tool-end') emit({type:'tool_execution_end',toolName:'final_review',toolCallId:mode === 'mismatched-tool-end' ? 'wrong-id' : 'review-1',isError:mode === 'error-result',result:{content:[{type:'text',text:'Review captured.'}],details:{accepted:true}}});
}
if (mode === 'fatal-exit') {
 emit({type:'tool_execution_end',toolName:'bash',toolCallId:'private-tool',result:{content:[{type:'text',text:'HOST-TOOL-SECRET-do-not-publish'}]}});
 emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'PRIVATE-MODEL-TEXT-do-not-publish'}]}});
 process.stderr.write('x'.repeat(2200) + '\\nFixture verbose CLI stderr detail STDERR-HOST-SECRET-do-not-publish\\n');
}
if (mode !== 'missing-completion') emit({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'Review submitted.'}],stopReason:['fatal-error','fatal-exit'].includes(mode) ? 'error' : mode === 'aborted' ? 'aborted' : mode === 'length' ? 'length' : 'stop',...(['fatal-error','fatal-exit'].includes(mode) ? {errorMessage:'Fixture safe terminal diagnostic token=' + process.env.OPENAI_API_KEY} : {})}]});
if (mode === 'fatal-exit') process.exit(1);
`);
  await chmod(fake, 0o755);
  const state = { requests: [], posts: [], reviews: [], files, changedFiles: files.length, stale: false, reads: 0 };
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8');
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    state.requests.push({ path: request.url, method: request.method, body: parsed });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      state.posts.push({ path: request.url, body: parsed });
      if (request.url.endsWith('/reviews')) {
        if (state.publicationStatus) {
          response.statusCode = state.publicationStatus;
          response.end(JSON.stringify({ message: 'Fixture publication rejected' }));
          return;
        }
        const receipt = { id: state.posts.length, commit_id: parsed.commit_id, body: parsed.body, state: parsed.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED' };
        state.reviews.push(receipt);
        response.end(JSON.stringify(receipt));
      } else response.end(JSON.stringify({ id: state.posts.length }));
    } else if (request.url.startsWith('/repos/org/repo/pulls/1/reviews')) {
      response.end(JSON.stringify(state.reviews));
    } else if (request.url.startsWith('/repos/org/repo/pulls/1/files?')) {
      const page = Number(new URL(request.url, 'http://fixture').searchParams.get('page'));
      response.end(JSON.stringify(state.files.slice((page - 1) * 100, page * 100)));
    } else if (request.url === '/repos/org/repo/pulls/1') {
      state.reads++;
      response.end(JSON.stringify({ state: 'open', changed_files: state.changedFiles, head: { sha: state.stale && state.reads > 1 ? previous : head }, base: { sha: base, repo: { clone_url: pathToFileURL(repo).href } } }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  return { state, api, head, base, previous, temp, repo, capture, localDiff, env, hostSentinel,
    async run({ mode = 'approve', preset = 'sol-xhigh', approved = 'alice', requester = 'Alice', full = false, providerEnv = {}, timeoutMs } = {}) {
      return runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--repo', 'org/repo', '--pr', '1', '--requester', requester, '--preset', preset, ...(full ? ['--full'] : [])], {
        timeoutMs,
        env: { ...env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', OPENAI_API_KEY: '', GITHUB_API_URL: api, CODJIFLO_RESULT_PATH: join(temp, 'publication.json'), CODJIFLO_APPROVED_USERS: approved, CODJIFLO_OMP_BIN: fake, FIXTURE_MODE: mode, FIXTURE_CAPTURE: capture, ...providerEnv },
      });
    },
    async close() { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); },
  };
}
