import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './fixture.mjs';
import { runProcess } from '../src/runner.mjs';
import { review } from '../src/review.mjs';

async function submoduleFixture() {
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
  await git(f.repo, ['submodule', 'add', '../sdk', 'SolidworksMCP-python']);
  await git(f.repo, ['config', '-f', '.gitmodules', 'submodule.SolidworksMCP-python.branch', 'main']);
  await git(f.repo, ['config', '-f', '.gitmodules', 'submodule.SolidworksMCP-python.update', 'merge']);
  await git(f.repo, ['commit', '-am', 'pin SDK']);
  const head = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
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

test('review checkout recursively materializes exact pinned submodules with sanitized Git auth environment', async () => {
  const s = await submoduleFixture();
  try {
    let invoked = false;
    await review({
      request, github: s.github, output: join(dirname(s.f.repo), 'result.json'),
      env: {
        ...s.f.env, CODJIFLO_APPROVED_USERS: 'alice', GITHUB_TOKEN: 'fake-publication-token',
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
      request, github: s.github, env: { ...s.f.env, CODJIFLO_APPROVED_USERS: 'alice' },
      reviewer: async () => { invoked = true; throw new Error('must not review incomplete checkout'); },
    }));
    assert.equal(invoked, false);
    assert.equal(s.posts.filter(post => post.path.endsWith('/reviews')).length, 0);
    assert.match(s.posts.at(-1).body.body, /failed/);
  } finally { await s.f.close(); }
});
