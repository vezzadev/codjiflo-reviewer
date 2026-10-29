import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { fixture } from './fixture.mjs';
import { runProcess } from '../src/runner.mjs';
import { review } from '../src/review.mjs';

async function submoduleFixture({ sdkPath = 'SolidworksMCP-python', unavailableUrl, unavailablePath = 'private-references' } = {}) {
  const f = await fixture();
  const root = dirname(f.repo);
  const git = (cwd, args) => runProcess('git', args, { cwd, env: f.env });
  // Local transport is an explicit operator setting, not a production bypass.
  await git(f.repo, ['config', '--global', 'protocol.file.allow', 'always']);
  async function repository(name) {
    const cwd = join(root, name);
    await mkdir(cwd);
    await git(cwd, ['init', '-b', 'main']);
    await writeFile(join(cwd, 'source.txt'), `${name} pinned\n`);
    await git(cwd, ['add', '.']);
    await git(cwd, ['commit', '-m', 'pinned source']);
    return cwd;
  }
  const leaf = await repository('leaf');
  const leafHead = (await git(leaf, ['rev-parse', 'HEAD'])).trim();
  const sdk = await repository('sdk');
  await git(sdk, ['submodule', 'add', '../leaf', 'nested']);
  await git(sdk, ['config', '-f', '.gitmodules', 'submodule.nested.update', 'rebase']);
  await git(sdk, ['commit', '-am', 'pin nested SDK']);
  const sdkHead = (await git(sdk, ['rev-parse', 'HEAD'])).trim();
  await git(f.repo, ['--literal-pathspecs', 'submodule', 'add', '../sdk', sdkPath]);
  await git(f.repo, ['config', '-f', '.gitmodules', `submodule.${sdkPath}.branch`, 'main']);
  await git(f.repo, ['config', '-f', '.gitmodules', `submodule.${sdkPath}.update`, 'merge']);
  if (unavailableUrl) {
    await git(f.repo, ['config', '-f', '.gitmodules', `submodule.${unavailablePath}.path`, unavailablePath]);
    await git(f.repo, ['config', '-f', '.gitmodules', `submodule.${unavailablePath}.url`, unavailableUrl]);
    await git(f.repo, ['update-index', '--add', '--cacheinfo', `160000,${sdkHead},${unavailablePath}`]);
  }
  // Preserve synthetic unavailable gitlinks in the index: commit -a would
  // treat their intentionally absent worktree directories as deletions.
  await git(f.repo, ['add', '.gitmodules']);
  await git(f.repo, ['commit', '-m', 'pin SDK']);
  const head = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
  if (unavailableUrl) {
    assert.equal(await git(f.repo, ['--literal-pathspecs', 'ls-tree', '-r', head, '--', unavailablePath]),
      `160000 commit ${sdkHead}\t${unavailablePath}\n`);
  }
  // The remote tips must not replace the gitlinks captured above.
  for (const cwd of [leaf, sdk]) {
    await writeFile(join(cwd, 'source.txt'), 'moving branch is not review evidence\n');
    await git(cwd, ['commit', '-am', 'advance tracking branch']);
  }
  const posts = [];
  const github = {
    token: 'fake-submodule-checkout-token',
    async request(path, options) {
      if (options?.method === 'POST') {
        posts.push({ path, body: options.body });
        return { id: posts.length, commit_id: head, body: options.body.body, state: options.body.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED' };
      }
      return { state: 'open', changed_files: f.state.files.length, head: { sha: head }, base: { sha: f.base, repo: { clone_url: pathToFileURL(f.repo).href } } };
    },
    async list() { return f.state.files; },
  };
  return { f, git, leaf, leafHead, sdkHead, head, posts, github };
}

const request = { repo: 'org/repo', number: 1, requester: 'Alice', preset: 'sol-xhigh', mode: 'full' };

test('source selection rejects malformed values, unsafe paths, and non-gitlinks before review', async t => {
  const s = await submoduleFixture();
  try {
    const values = [
      '', '[', 'null', '{}', '"SolidworksMCP-python"', 'true', '1',
      '[null]', '[1]', '[{}]', '[[]]',
      ...['', '/', '/SolidworksMCP-python', '../sdk', 'a/../SolidworksMCP-python',
        './SolidworksMCP-python', 'SolidworksMCP-python/', 'a//b', 'a/./b', 'a\\b',
        'C:/sdk', '.git/modules/sdk', 'a/.GIT/b', 'sdk\0bad', 'sdk\nbad',
        ':(glob)*', ':SolidworksMCP-python', '*', 'SolidworksMCP-*',
        'solidworksmcp-python', 'a.js', '.gitmodules', 'missing',
        'SolidworksMCP-python/nested',
      ].map(path => JSON.stringify([path])),
    ];
    for (const value of values) await t.test(JSON.stringify(value), async () => {
      let invoked = false;
      await assert.rejects(review({
        request, github: s.github,
        env: { ...s.f.env, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_SOURCE_SUBMODULES: value },
        reviewer: async () => { invoked = true; throw new Error('must not review invalid selection'); },
      }), /CODJIFLO_SOURCE_SUBMODULES|not an exact gitlink path/);
      assert.equal(invoked, false);
    });
    assert.equal(s.posts.filter(post => post.path.endsWith('/reviews')).length, 0);
  } finally { await s.f.close(); }
});

for (const selection of [undefined, '[]', '["SolidworksMCP-python"]', '["private-references"]']) {
  test(`unavailable private root dependency is fetched only when selected: ${selection ?? 'unset'}`, async () => {
    // Real HTTP 404 matches a private repository unavailable to the root-scoped
    // token. It is a tracked gitlink, not a mocked subprocess failure.
    const unavailable = await gitHttpServer({});
    const s = await submoduleFixture({ unavailableUrl: `${unavailable.origin}/private-references` });
    try {
      let invoked = false;
      const pending = review({
        request, github: s.github, output: join(dirname(s.f.repo), 'result.json'),
        env: { ...s.f.env, NO_PROXY: '*', no_proxy: '*', CODJIFLO_APPROVED_USERS: 'alice',
          ...(selection === undefined ? {} : { CODJIFLO_SOURCE_SUBMODULES: selection }) },
        reviewer: async ({ cwd, env }) => {
          invoked = true;
          assert.match(await readFile(join(cwd, '.gitmodules'), 'utf8'), /private-references/);
          await assert.rejects(readFile(join(cwd, 'private-references', '.git')), { code: 'ENOENT' });
          const config = await runProcess('git', ['config', '--local', '--list'], { cwd, env });
          assert.doesNotMatch(config, /submodule\.private-references\./);
          if (selection === '["SolidworksMCP-python"]') {
            assert.equal(await readFile(join(cwd, 'SolidworksMCP-python', 'nested', 'source.txt'), 'utf8'), 'leaf pinned\n');
          } else {
            await assert.rejects(readFile(join(cwd, 'SolidworksMCP-python', '.git')), { code: 'ENOENT' });
            assert.doesNotMatch(config, /submodule\./);
          }
          return { verdict: 'APPROVE', summary: 'Only configured source dependencies inspected.', findings: [] };
        },
      });
      if (selection === '["private-references"]') {
        await assert.rejects(pending, error => {
          assert.equal(error.termination, 'exit');
          assert.match(error.message, /private-references.*not found/);
          return true;
        });
        assert.equal(invoked, false);
        assert.ok(unavailable.calls.some(call => call.path.startsWith('/private-references/')));
        assert.equal(s.posts.filter(post => post.path.endsWith('/reviews')).length, 0);
      } else {
        await pending;
        assert.equal(invoked, true);
        assert.deepEqual(unavailable.calls, []);
        assert.equal(s.posts.filter(post => post.path.endsWith('/reviews')).length, 1);
      }
    } finally {
      await unavailable.close();
      await s.f.close();
    }
  });
}

test('real Git treats wildcard characters in selected gitlink paths literally', async () => {
  const unavailable = await gitHttpServer({});
  const s = await submoduleFixture({
    sdkPath: 'vendor/sdk[1]', unavailablePath: 'vendor/sdk1', unavailableUrl: `${unavailable.origin}/private-references`,
  });
  try {
    let invoked = false;
    await review({
      request, github: s.github, output: join(dirname(s.f.repo), 'result.json'),
      env: { ...s.f.env, NO_PROXY: '*', no_proxy: '*', CODJIFLO_APPROVED_USERS: 'alice',
        CODJIFLO_SOURCE_SUBMODULES: '["vendor/sdk[1]"]', GIT_GLOB_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1' },
      reviewer: async ({ cwd }) => {
        invoked = true;
        assert.equal(await readFile(join(cwd, 'vendor/sdk[1]', 'nested', 'source.txt'), 'utf8'), 'leaf pinned\n');
        await assert.rejects(readFile(join(cwd, 'vendor/sdk1', '.git')), { code: 'ENOENT' });
        return { verdict: 'APPROVE', summary: 'Literal source path inspected.', findings: [] };
      },
    });
    assert.equal(invoked, true);
    assert.deepEqual(unavailable.calls, []);
  } finally {
    await unavailable.close();
    await s.f.close();
  }
});

test('review checkout recursively materializes exact pinned submodules with sanitized Git auth environment', async () => {
  const s = await submoduleFixture();
  try {
    let invoked = false;
    await review({
      request, github: s.github, output: join(dirname(s.f.repo), 'result.json'),
      env: {
        ...s.f.env, CODJIFLO_APPROVED_USERS: 'alice', GITHUB_TOKEN: 'fake-publication-token',
        CODJIFLO_SOURCE_SUBMODULES: '["SolidworksMCP-python"]',
        GIT_DIR: '/missing-caller-repository', GIT_WORK_TREE: '/missing-caller-worktree',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'never',
        GIT_CONFIG_PARAMETERS: "'submodule.recurse=false'", GIT_ICASE_PATHSPECS: '1',
      },
      reviewer: async ({ cwd, env }) => {
        invoked = true;
        const inspect = (path, args) => runProcess('git', args, { cwd: path, env });
        const sdk = join(cwd, 'SolidworksMCP-python');
        const nested = join(sdk, 'nested');
        assert.equal((await inspect(cwd, ['rev-parse', 'HEAD'])).trim(), s.head);
        assert.equal((await inspect(sdk, ['rev-parse', 'HEAD'])).trim(), s.sdkHead);
        assert.equal((await inspect(nested, ['rev-parse', 'HEAD'])).trim(), s.leafHead);
        assert.equal(await readFile(join(nested, 'source.txt'), 'utf8'), 'leaf pinned\n');
        assert.doesNotMatch(await inspect(sdk, ['config', '--list', '--show-origin']), /AUTHORIZATION|fake-submodule-checkout-token/);
        assert.ok(!Object.keys(env).some(name => /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|GITHUB_TOKEN|GH_TOKEN)$/i.test(name)));
        return { verdict: 'APPROVE', summary: 'Pinned SDK evidence inspected.', findings: [] };
      },
    });
    assert.equal(invoked, true);
    assert.equal(s.posts.filter(post => post.path.endsWith('/reviews')).length, 1);
  } finally { await s.f.close(); }
});

test('unavailable nested pinned submodule fails before reviewer invocation and publishes no verdict', async () => {
  const s = await submoduleFixture();
  try {
    await rm(s.leaf, { recursive: true, force: true });
    let invoked = false;
    await assert.rejects(review({
      request, github: s.github, env: { ...s.f.env, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_SOURCE_SUBMODULES: '["SolidworksMCP-python"]' },
      reviewer: async () => { invoked = true; throw new Error('must not review incomplete checkout'); },
    }));
    assert.equal(invoked, false);
    assert.equal(s.posts.filter(post => post.path.endsWith('/reviews')).length, 0);
    assert.match(s.posts.at(-1).body.body, /failed/);
  } finally { await s.f.close(); }
});

// Serve Git's real dumb-HTTP protocol, not a mocked Git runner. Recording each
// request exposes the inherited header used by recursive submodule processes.
async function gitHttpServer(repositories, host = '127.0.0.1') {
  const calls = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture.invalid').pathname;
    calls.push({ path, authorization: req.headers.authorization });
    const [name, ...parts] = path.slice(1).split('/');
    if (!repositories[name] || parts.some(part => part === '..' || part === '')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(join(repositories[name], '.git', ...parts));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {
    origin: `http://${host}:${server.address().port}`,
    calls,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

for (const transport of ['http', 'http-cross-port', 'file', 'ssh-url', 'ssh-scp']) {
  test(`${transport} root checkout scopes fake HTTP auth without leaking it to cross-origin submodules`, async () => {
    const s = await submoduleFixture();
    const root = dirname(s.f.repo);
    const sdk = join(root, 'sdk');
    const isHttp = transport.startsWith('http');
    const trusted = await gitHttpServer({ repo: s.f.repo, sdk });
    const foreign = await gitHttpServer({ leaf: s.leaf }, transport === 'http-cross-port' ? '127.0.0.1' : '127.0.0.2');
    try {
      // Root and SDK share an origin; the nested leaf changes host or port.
      await s.git(sdk, ['config', '-f', '.gitmodules', 'submodule.nested.url', `${foreign.origin}/leaf`]);
      await s.git(sdk, ['commit', '-am', 'use cross-origin nested transport']);
      const sdkHead = (await s.git(sdk, ['rev-parse', 'HEAD'])).trim();
      await s.git(s.f.repo, ['config', '-f', '.gitmodules', 'submodule.SolidworksMCP-python.url', `${trusted.origin}/sdk`]);
      await s.git(s.f.repo, ['add', '.gitmodules']);
      await s.git(s.f.repo, ['update-index', '--cacheinfo', `160000,${sdkHead},SolidworksMCP-python`]);
      await s.git(s.f.repo, ['commit', '-m', 'pin HTTP transport fixture']);
      const head = (await s.git(s.f.repo, ['rev-parse', 'HEAD'])).trim();
      for (const repo of [s.f.repo, sdk, s.leaf]) await s.git(repo, ['update-server-info']);

      let cloneUrl = isHttp ? `${trusted.origin}/repo` : pathToFileURL(s.f.repo).href;
      const env = { ...s.f.env, CODJIFLO_APPROVED_USERS: 'alice', CODJIFLO_SOURCE_SUBMODULES: '["SolidworksMCP-python"]', NO_PROXY: '*', no_proxy: '*', GITHUB_TOKEN: 'fake-publication-token', GH_TOKEN: 'fake-gh-token' };
      const sshCapture = join(root, 'ssh-capture.jsonl');
      if (transport.startsWith('ssh-')) {
        // A real Git SSH transport with a local upload-pack process. No daemon,
        // network credentials, or copied-option assertion is involved.
        const ssh = join(root, 'fixture-ssh.mjs');
        await writeFile(ssh, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = spawnSync('git', ['config', '--list', '--show-origin'], { encoding: 'utf8' });
appendFileSync(${JSON.stringify(sshCapture)}, JSON.stringify({ args: process.argv.slice(2), config: config.stdout, env: process.env }) + '\\n');
const command = process.argv.at(-1);
if (!command.startsWith('git-upload-pack ')) process.exit(1);
const result = spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
        await chmod(ssh, 0o700);
        env.GIT_SSH_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(ssh)}`;
        env.GIT_SSH_VARIANT = 'ssh';
        cloneUrl = transport === 'ssh-url' ? `ssh://git@fixture.invalid${s.f.repo}` : `git@fixture.invalid:${s.f.repo}`;
      }
      const github = {
        ...s.github,
        async request(path, options) {
          if (options?.method === 'POST') return { ...await s.github.request(path, options), commit_id: head };
          return { state: 'open', changed_files: s.f.state.files.length, head: { sha: head }, base: { sha: s.f.base, repo: { clone_url: cloneUrl } } };
        },
      };
      let invoked = false;
      const encodedToken = Buffer.from(`x-access-token:${github.token}`).toString('base64');
      await review({
        request, github, env, output: join(root, 'result.json'),
        reviewer: async ({ cwd, env: reviewerEnv }) => {
          invoked = true;
          assert.equal(await readFile(join(cwd, 'SolidworksMCP-python', 'nested', 'source.txt'), 'utf8'), 'leaf pinned\n');
          assert.equal((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: join(cwd, 'SolidworksMCP-python'), env: reviewerEnv })).trim(), sdkHead);
          const configs = await Promise.all([cwd, join(cwd, 'SolidworksMCP-python'), join(cwd, 'SolidworksMCP-python', 'nested')].map(path =>
            runProcess('git', ['config', '--list', '--show-origin'], { cwd: path, env: reviewerEnv })));
          const exposed = JSON.stringify({ configs, env: reviewerEnv });
          for (const secret of [github.token, encodedToken, env.GITHUB_TOKEN, env.GH_TOKEN]) assert.ok(!exposed.includes(secret));
          assert.doesNotMatch(exposed, /authorization|http\.null\//i);
          assert.ok(!Object.keys(reviewerEnv).some(name => /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|GITHUB_TOKEN|GH_TOKEN)$/i.test(name)));
          // Operator transport configuration must remain usable, not be removed
          // wholesale to stop the header leak.
          assert.equal(await runProcess('git', ['config', '--get', 'protocol.file.allow'], { cwd, env: reviewerEnv }), 'always\n');
          if (transport.startsWith('ssh-')) assert.equal(reviewerEnv.GIT_SSH_COMMAND, env.GIT_SSH_COMMAND);
          return { verdict: 'APPROVE', summary: 'Transport evidence inspected.', findings: [] };
        },
      });
      assert.equal(invoked, true);
      const sdkCalls = trusted.calls.filter(call => call.path.startsWith('/sdk/'));
      assert.ok(sdkCalls.length > 0, 'same-origin SDK must actually be fetched');
      if (isHttp) {
        const rootCalls = trusted.calls.filter(call => call.path.startsWith('/repo/'));
        assert.ok(rootCalls.length > 0, 'root must actually be fetched over HTTP');
        assert.ok([...rootCalls, ...sdkCalls].every(call => call.authorization === `basic ${encodedToken}`));
      } else {
        assert.ok(sdkCalls.every(call => call.authorization === undefined), 'non-HTTP root must not confer HTTP credentials');
      }
      assert.ok(foreign.calls.length > 0, 'cross-origin nested submodule must actually be fetched');
      assert.ok(foreign.calls.every(call => call.authorization === undefined), 'nested submodule must not receive the root token');
      if (transport.startsWith('ssh-')) {
        const captures = (await readFile(sshCapture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(captures.some(capture => capture.args.at(-1).startsWith('git-upload-pack ')));
        for (const capture of captures) {
          assert.doesNotMatch(capture.config, /extraheader|http\.null\//i);
          assert.ok(!Object.keys(capture.env).some(name => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(name)));
        }
      }
    } finally {
      await Promise.all([trusted.close(), foreign.close()]);
      await s.f.close();
    }
  });
}
