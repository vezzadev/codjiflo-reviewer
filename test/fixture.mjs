import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../src/runner.mjs';

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
  const home = join(temp, 'home');
  await mkdir(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODJIFLO_ANTHROPIC_KEYS_FILE: join(temp, 'missing-keys.json'), CODJIFLO_CLAUDE_STATE_FILE: join(temp, 'claude-state.json'), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
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
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (process.argv[2] === 'auth') {
 if (Object.keys(process.env).some(name => /^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_))/.test(name))) throw new Error('OAuth status inherited provider credentials');
 console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));
 process.exit(0);
}
process.stdin.setEncoding('utf8');
let input = ''; for await (const chunk of process.stdin) input += chunk;
await writeFile(process.env.FIXTURE_CAPTURE + '.stdin', input);
if (process.argv.includes('exec')) {
 const manifestLine = input.split('\\n').find(line => line.startsWith('Review input manifest: '));
 if (manifestLine) {
  const manifest = JSON.parse(manifestLine.slice('Review input manifest: '.length));
  let complete = '';
  for (let part = 0; part < manifest.parts; part++) complete += await readFile(join(manifest.directory, part + '.txt'), 'utf8');
  if (complete.length !== manifest.characters || Buffer.byteLength(complete) !== manifest.bytes) throw new Error('Incomplete staged review input');
  input = complete;
 }
}
await writeFile(process.env.FIXTURE_CAPTURE, input);
if (process.argv.includes('exec')) console.log(JSON.stringify({type:'thread.started',thread_id:'fixture CLI streaming live'}));
else process.stdout.write('fixture CLI streaming live\\n');
process.stderr.write('fixture stderr streaming live\\n');
if (process.env.FIXTURE_MODE === 'failure') process.exit(9);
const findings = process.env.FIXTURE_MODE === 'findings' ? [
 {path:'a.js',side:'LEFT',start_line:1,line:1,priority:'P1',disposition:'blocking',title:'Old-side bug',body:'Concrete failure scenario.'},
 {path:'a.js',side:'RIGHT',start_line:1,line:2,priority:'P2',disposition:'blocking',title:'Range bug',body:'Concrete failure scenario.'}
] : [];
const result = {verdict: findings.length ? 'REQUEST_CHANGES' : 'APPROVE',summary:'Fixture review complete.',findings};
if (process.argv.includes('exec')) {
 const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
 await writeFile(output, process.env.FIXTURE_MODE === 'malformed' ? '{' : JSON.stringify(result));
 if (process.env.FIXTURE_MODE === 'input-too-large') {
  console.log(JSON.stringify({type:'error',message:'Input exceeds the maximum length of 1048576 characters. input_too_large'}));
  process.exit(1);
 }
 if (process.env.FIXTURE_MODE === 'error-event') console.log(JSON.stringify({type:'error',message:'Fixture terminal error despite result file'}));
 if (process.env.FIXTURE_MODE === 'failed-turn') console.log(JSON.stringify({type:'turn.failed',error:{message:'Fixture provider failed despite result file'}}));
 else if (process.env.FIXTURE_MODE !== 'missing-completion') console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
} else {
 // stdout is valid JSONL in Claude mode (no unstructured status lines).
 if (Object.keys(process.env).some(name => /^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_))/.test(name))) throw new Error('OAuth fixture inherited provider credentials');
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:process.env.FIXTURE_MODE === 'error-result',structured_output:result}));
}
`);
  // Claude's real stream is JSONL, so keep fake status in stderr only in this mode.
  const fakeClaude = join(temp, 'fake-claude.mjs');
  const source = await readFile(fake, 'utf8');
  await writeFile(fakeClaude, source.replace("process.stdout.write('fixture CLI streaming live\\n');", "console.log(JSON.stringify({type:'assistant',message:'fixture live'}));"));
  await chmod(fake, 0o755); await chmod(fakeClaude, 0o755);
  const state = { requests: [], posts: [], reviews: [], files, changedFiles: files.length, stale: false, reads: 0 };
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8');
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : undefined;
    state.requests.push({ path: request.url, method: request.method, body: parsed });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      state.posts.push({ path: request.url, body: parsed });
      response.end(JSON.stringify({ id: state.posts.length }));
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
  return { state, head, base, previous, temp, repo, capture, localDiff, env, hostSentinel,
    async run({ mode = 'approve', preset = 'sol-xhigh', approved = 'alice', requester = 'Alice', full = false, providerEnv = {}, timeoutMs } = {}) {
      return runProcess(process.execPath, [resolve('bin/codjiflo-reviewer.mjs'), '--repo', 'org/repo', '--pr', '1', '--requester', requester, '--preset', preset, ...(full ? ['--full'] : [])], {
        timeoutMs,
        env: { ...env, GITHUB_EVENT_PATH: '', GITHUB_TOKEN: 'fixture-token-not-real', GITHUB_API_URL: api, CODJIFLO_APPROVED_USERS: approved, CODJIFLO_CODEX_BIN: fake, CODJIFLO_CLAUDE_BIN: fakeClaude, FIXTURE_MODE: mode, FIXTURE_CAPTURE: capture, ...providerEnv },
      });
    },
    async close() { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); },
  };
}
