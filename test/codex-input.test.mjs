import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { review } from '../src/review.mjs';
import { reviewInput, MAX_INLINE_INPUT } from '../src/evidence.mjs';
import { runProcess } from '../src/runner.mjs';
import { fixture } from './fixture.mjs';
import { prompt } from '../src/prompt.mjs';

const verdicts = f => f.state.posts.filter(post => post.path.endsWith('/reviews'));

const manifestOf = input => JSON.parse(input.split('\n').find(line => line.startsWith('Navigable review evidence manifest: ')).slice('Navigable review evidence manifest: '.length));

async function readRange(directory, name, start, size = 6000) {
  const output = await runProcess(process.execPath, [join(directory, 'read-evidence.mjs'), name, String(start), String(size)]);
  const newline = output.indexOf('\n');
  return { ...JSON.parse(output.slice(0, newline)), text: output.slice(newline + 1) };
}

test('large full and incremental reviews keep methodology inline and expose complete navigable evidence', async () => {
  const f = await fixture({ newLine: 'é🙂漢'.repeat(300000) });
  try {
    for (const full of [true, false]) {
      if (!full) f.state.reviews = [{ state: 'APPROVED', commit_id: f.previous, body: `<!-- codjiflo-reviewer:v3 ${JSON.stringify({ head: f.previous, base: f.base, preset: 'sol-xhigh' })} -->` }];
      await f.run({ full });
      const input = await readFile(f.capture, 'utf8');
      assert.ok(input.length < 16000, 'initial prompt does not grow with duplicated patch evidence');
      const manifest = manifestOf(input);
      const checkout = await readFile(f.capture + '.cwd', 'utf8');
      const fromCheckout = relative(checkout, manifest.directory);
      assert.ok(fromCheckout === '..' || fromCheckout.startsWith('..' + sep), 'evidence is outside the actual CLI checkout');
      const directory = f.capture + '.evidence';
      const scope = await readFile(join(directory, 'review-scope.diff'), 'utf8');
      if (full) assert.equal(scope, f.localDiff);
      else {
        assert.match(input, new RegExp(`git diff ${f.previous} ${f.head}`));
        assert.equal(scope, await runProcess('git', ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', f.previous, f.head, '--'], { cwd: f.repo, env: f.env }));
      }
      const records = (await readFile(join(directory, 'inventory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const scopes = records.filter(record => record.scope);
      assert.equal(scopes.length, manifest.scopeFiles);
      assert.equal(scopes.reduce((sum, record) => sum + record.scope.bytes, 0), Buffer.byteLength(scope));
      const current = JSON.parse(await readFile(join(directory, 'pr-patches.json'), 'utf8'));
      assert.deepEqual(current, f.state.files.map(file => ({ filename: file.filename, patch: file.patch })));
      const apiRecord = records.find(record => record.api);
      const apiBytes = await readFile(join(directory, 'pr-patches.json'));
      assert.deepEqual(JSON.parse(apiBytes.subarray(apiRecord.api.start, apiRecord.api.start + apiRecord.api.bytes)), current[0]);
      assert.equal(verdicts(f).at(-1).body.event, 'APPROVE');
    }
  } finally { await f.close(); }
});

test('oversized custom methodology fails closed before provider invocation or publication', async () => {
  const f = await fixture({ headPrompt: 'Inspect café 🙂 cancellation.\n'.repeat(45000) });
  try {
    await assert.rejects(f.run({ full: true }));
    assert.equal(verdicts(f).length, 0);
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
    assert.match(f.state.posts.at(-1).body.body, /instructions exceed/);
  } finally { await f.close(); }
});

test('unprocessed large scope returns INCOMPLETE without publishing a defect verdict', async () => {
  const f = await fixture({ newLine: 'x'.repeat(600000) });
  try {
    await assert.rejects(f.run({ mode: 'incomplete-input', full: true }));
    assert.equal(verdicts(f).length, 0);
  } finally { await f.close(); }
});

test('small Codex prompts are unchanged and require no evidence query', async () => {
  const options = { level: 'xhigh', mode: 'full', base: 'a', head: 'b', scope: 'a', diff: 'small', currentDiff: '[]' };
  assert.equal(await reviewInput({ preset: { cli: 'codex' }, options, git: () => { throw new Error('Unexpected git query'); } }), prompt(options));
});

test('range inventory preserves escaped rename paths, binary files, UTF-8 and late-file evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-evidence-test-'));
  const cwd = join(temp, 'repository');
  await mkdir(cwd);
  const filename = '-odd\\name\t"é🙂\n.js';
  const previous = 'old\n\t"漢.js';
  const first = 'diff --git a/first b/first\n' + 'é🙂漢'.repeat(150000) + '\n';
  const last = 'diff --git a/last b/last\nBinary files differ\n';
  const options = { level: 'xhigh', mode: 'incremental', base: 'a', head: 'b', scope: 'c', diff: first + last, currentDiff: JSON.stringify([{ filename, previous_filename: previous, patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'last', patch: null }]), customInstructions: 'Inspect complete scope with custom methodology.' };
  try {
    const input = await reviewInput({ preset: { cli: 'codex' }, options, temp, cwd, git: async args => {
      assert.ok(args.includes('-z'));
      assert.deepEqual(args.slice(-3), ['c', 'b', '--']);
      return `1\t1\t\0${previous}\0${filename}\0-\t-\tlast\0`;
    } });
    assert.ok(input.includes(options.customInstructions));
    const manifest = manifestOf(input);
    assert.ok(input.length < MAX_INLINE_INPUT);
    const records = (await readFile(join(manifest.directory, 'inventory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records[0].filename, filename);
    assert.equal(records[0].previous_filename, previous);
    assert.equal(records[1].additions, null);
    assert.equal(records.length, 2, 'API ranges join their matching scope records');
    assert.equal(records[1].anchors, false);
    const late = await readRange(manifest.directory, 'review-scope.diff', records[1].scope.start);
    assert.equal(late.text, last, 'late file can be inspected without loading the earlier huge file');
    const a = await readRange(manifest.directory, 'review-scope.diff', 0, 31);
    const b = await readRange(manifest.directory, 'review-scope.diff', a.next, 31);
    assert.ok(!a.text.includes('\ufffd') && !b.text.includes('\ufffd'));
    assert.equal(a.text + b.text, Buffer.from(first).subarray(0, b.next).toString('utf8'));
    assert.ok(a.bytes <= 31 && b.bytes <= 31);
    const api = await readRange(manifest.directory, 'pr-patches.json', records[0].api.start, records[0].api.bytes);
    assert.equal(JSON.parse(api.text).filename, filename);
    await assert.rejects(readRange(manifest.directory, '../repository/secret', 0));
    await assert.rejects(readRange(manifest.directory, 'review-scope.diff', -1));
    await assert.rejects(readRange(manifest.directory, 'review-scope.diff', 0, 6001));
    await assert.rejects(readRange(manifest.directory, 'review-scope.diff', Buffer.byteLength('diff --git a/first b/first\n') + 1));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('incremental consumers retrieve joined scope and API ranges while retaining API-only files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-joined-evidence-'));
  const first = 'diff --git a/scope-only b/scope-only\n' + 'é🙂漢'.repeat(150000) + '\n';
  const last = 'diff --git a/old-name b/current-name\nsimilarity index 90%\nrename from old-name\nrename to current-name\n';
  const api = [
    ...Array.from({ length: 80 }, (_, index) => ({ filename: `other-${index}`, patch: null })),
    { filename: 'old-name', patch: '@@ -1 +1 @@\n-old\n+other' },
    { filename: 'current-name', previous_filename: 'old-name', patch: '@@ -1 +1 @@\n-before\n+after' },
  ];
  try {
    const input = await reviewInput({
      preset: { cli: 'codex' }, temp, cwd: join(temp, 'repository'),
      options: { level: 'xhigh', mode: 'incremental', base: 'a', scope: 'c', head: 'b', diff: first + last, currentDiff: JSON.stringify(api) },
      git: async () => '1\t1\tscope-only\0' + '1\t1\t\0old-name\0current-name\0',
    });
    const manifest = manifestOf(input);
    // Follow each matching record's ranges without rescanning for API anchors.
    let inventory = '', next = 0;
    while (next < manifest.inventoryBytes) {
      const chunk = await readRange(manifest.directory, 'inventory.jsonl', next);
      inventory += chunk.text;
      next = chunk.next;
    }
    const records = inventory.trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 83);
    const scopeOnly = records.find(record => record.filename === 'scope-only');
    assert.ok(scopeOnly.scope);
    assert.equal(scopeOnly.api, undefined);
    assert.equal(scopeOnly.anchors, undefined);
    const joined = records.find(record => record.filename === 'current-name');
    assert.equal(joined.previous_filename, 'old-name');
    assert.equal(joined.anchors, true);
    const scopeRange = await readRange(manifest.directory, 'review-scope.diff', joined.scope.start, joined.scope.bytes);
    assert.equal(scopeRange.text, last);
    const apiRange = await readRange(manifest.directory, 'pr-patches.json', joined.api.start, joined.api.bytes);
    assert.deepEqual(JSON.parse(apiRange.text), api.at(-1));
    const previous = records.find(record => record.filename === 'old-name');
    assert.equal(previous.scope, undefined, 'previous filename does not join a different current filename');
    const previousRange = await readRange(manifest.directory, 'pr-patches.json', previous.api.start, previous.api.bytes);
    assert.deepEqual(JSON.parse(previousRange.text), api.at(-2));
    const apiOnly = records.find(record => record.filename === 'other-79');
    assert.equal(apiOnly.scope, undefined);
    assert.equal(apiOnly.anchors, false);
    const apiOnlyRange = await readRange(manifest.directory, 'pr-patches.json', apiOnly.api.start, apiOnly.api.bytes);
    assert.deepEqual(JSON.parse(apiOnlyRange.text), api[79]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('rename disagreements retain primary joins and expose alternate API anchor ranges', async t => {
  for (const variant of [
    {
      name: 'scope deletion and addition with an API rename',
      scope: [{ filename: 'a' }, { filename: 'b' }],
      api: [{ filename: 'b', previous_filename: 'a', patch: '@@ -1 +1 @@\n-before\n+after' }],
      target: 'a', related: 'b',
    },
    {
      name: 'scope rename with API deletion and addition',
      scope: [{ filename: 'b', previous_filename: 'a' }],
      api: [{ filename: 'a', patch: '@@ -1 +0,0 @@\n-before' }, { filename: 'b', patch: '@@ -0,0 +1 @@\n+after' }],
      target: 'b', related: 'a',
    },
    {
      name: 'incremental rename keeps its own previous filename despite same-name API metadata',
      scope: [{ filename: 'b', previous_filename: 'c' }],
      api: [{ filename: 'b', previous_filename: 'a', patch: '@@ -1 +1 @@\n-before\n+after' }, { filename: 'c', patch: null }],
      target: 'b', related: 'c',
    },
    {
      name: 'incremental same-name scope retains primary and alternate rename records',
      scope: [{ filename: 'a' }],
      api: [{ filename: 'a', patch: '@@ -0,0 +1 @@\n+replacement' }, { filename: 'b', previous_filename: 'a', patch: '@@ -1 +1 @@\n-before\n+after' }],
      target: 'a', related: 'b',
    },
  ]) await t.test(variant.name, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codjiflo-rename-evidence-'));
    const padding = 'diff --git a/padding b/padding\n' + 'x'.repeat(MAX_INLINE_INPUT) + '\n';
    const diff = padding + variant.scope.map(file => `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}\n`).join('');
    const numstat = '1\t0\tpadding\0' + variant.scope.map(file => file.previous_filename
      ? `1\t1\t\0${file.previous_filename}\0${file.filename}\0`
      : `1\t1\t${file.filename}\0`).join('');
    try {
      const input = await reviewInput({
        preset: { cli: 'codex' }, temp, cwd: join(temp, 'repository'),
        options: { level: 'xhigh', mode: 'incremental', base: 'base', scope: 'previous', head: 'head', diff, currentDiff: JSON.stringify(variant.api) },
        git: async () => numstat,
      });
      const manifest = manifestOf(input);
      const inventory = (await readFile(join(manifest.directory, 'inventory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      for (const scope of variant.scope) {
        const entry = inventory.find(record => record.filename === scope.filename);
        assert.equal(entry.previous_filename, scope.previous_filename, 'scope rename metadata remains authoritative for scope ranges');
        const primary = variant.api.find(record => record.filename === scope.filename);
        if (primary) {
          const actual = await readRange(manifest.directory, 'pr-patches.json', entry.api.start, entry.api.bytes);
          assert.deepEqual(JSON.parse(actual.text), primary);
          assert.equal(entry.anchors, primary.patch !== null);
        } else assert.equal(entry.api, undefined);
      }
      const entry = inventory.find(record => record.filename === variant.target);
      assert.equal(entry.apiRelated.length, 1);
      const candidate = entry.apiRelated[0];
      const expected = variant.api.find(record => record.filename === variant.related);
      assert.equal(candidate.filename, expected.filename);
      assert.equal(candidate.previous_filename, expected.previous_filename);
      assert.equal(candidate.anchors, expected.patch !== null);
      const actual = await readRange(manifest.directory, 'pr-patches.json', candidate.api.start, candidate.api.bytes);
      assert.deepEqual(JSON.parse(actual.text), expected, 'alternate API record is reachable without rescanning unrelated evidence');
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});

test('real Git type changes and non-LF content preserve complete consumer-visible ranges', async t => {
  for (const variant of ['separators', 'types', 'submodule']) {
    const typeChanges = variant !== 'separators', gitlink = variant === 'submodule';
    await t.test(variant, async () => {
      const temp = await mkdtemp(join(tmpdir(), 'codjiflo-git-evidence-'));
      const cwd = join(temp, 'repository');
      await mkdir(cwd);
      const home = join(temp, 'home');
      await mkdir(home);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const git = args => runProcess('git', args, { cwd, env });
      const commit = () => git(['-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'snapshot']);
      const toLink = 'a-to-link\t"é\n.txt', fromLink = 'b-from-link\t"漢\n.txt';
      const names = [...(typeChanges ? [toLink] : []), ...(variant === 'types' ? [fromLink] : []), 'c-content.txt', ...(variant === 'types' ? ['d-renamed.txt'] : []), ...(gitlink ? ['d-submodule', 'e-to-gitlink', 'f-from-gitlink'] : []), 'z-padding.txt', 'zz-late.txt'];
      const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3'];
      try {
        await git(['init', '-q']);
        await git(['config', 'diff.submodule', 'log']);
        await git(['config', '--global', 'diff.submodule', 'log']);
        if (gitlink) await git(['config', '--global', 'color.ui', 'always']);
        let seed;
        if (gitlink) {
          await git(['-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'submodule seed']);
          seed = (await git(['rev-parse', 'HEAD'])).trim();
        }
        for (const filename of names) {
          if (filename === 'd-submodule' || filename === 'f-from-gitlink') continue;
          if (filename === fromLink) await symlink('old-target', join(cwd, filename));
          else await writeFile(join(cwd, filename === 'd-renamed.txt' ? 'd-original.txt' : filename), `old ${filename}\n`);
        }
        await git(['add', '--all']);
        if (gitlink) {
          await git(['update-index', '--add', '--cacheinfo', `160000,${seed},d-submodule`]);
          await git(['update-index', '--add', '--cacheinfo', `160000,${seed},f-from-gitlink`]);
        }
        await commit();
        const base = (await git(['rev-parse', 'HEAD'])).trim();
        if (typeChanges) {
          await rm(join(cwd, toLink));
          await symlink('new-target', join(cwd, toLink));
          if (variant === 'types') {
            await rm(join(cwd, fromLink));
            await writeFile(join(cwd, fromLink), 'now a regular file\n');
          }
        }
        if (variant === 'types') {
          await writeFile(join(cwd, 'd-renamed.txt'), await readFile(join(cwd, 'd-original.txt')));
          await rm(join(cwd, 'd-original.txt'));
        }
        if (gitlink) {
          await rm(join(cwd, 'e-to-gitlink'));
          await writeFile(join(cwd, 'f-from-gitlink'), 'now a regular file\n');
        }
        const content = ['\r', '\u2028', '\u2029'].map(separator => `content${separator}diff --git a/fake b/fake\n`).join('');
        await writeFile(join(cwd, 'c-content.txt'), content);
        await writeFile(join(cwd, 'z-padding.txt'), 'x'.repeat(MAX_INLINE_INPUT) + '\n');
        await writeFile(join(cwd, 'zz-late.txt'), 'late evidence\n');
        await git(['add', '--all']);
        if (gitlink) {
          await git(['update-index', '--add', '--cacheinfo', `160000,${base},d-submodule`]);
          await git(['update-index', '--add', '--cacheinfo', `160000,${base},e-to-gitlink`]);
        }
        await commit();
        const head = (await git(['rev-parse', 'HEAD'])).trim();
        const diff = await git([...diffArgs, base, head, '--']);
        const inspect = async input => {
          const manifest = manifestOf(input);
          const records = (await readFile(join(manifest.directory, 'inventory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
          assert.deepEqual(records.filter(record => record.scope).map(record => record.filename), names);
          const stored = await readFile(join(manifest.directory, 'review-scope.diff'));
          assert.equal(stored.toString('utf8'), diff);
          assert.equal(manifest.scopeBytes, stored.length);
          let next = 0;
          for (const record of records.filter(record => record.scope)) {
            const expected = await git(['--literal-pathspecs', ...diffArgs, base, head, '--', ...(record.previous_filename ? [record.previous_filename] : []), record.filename]);
            assert.equal(record.scope.start, next);
            const end = next + record.scope.bytes;
            assert.equal(stored.subarray(next, end).toString('utf8'), expected);
            if (record.filename !== 'z-padding.txt') {
              const actual = await readRange(manifest.directory, 'review-scope.diff', next, record.scope.bytes);
              assert.equal(actual.text, expected);
              assert.equal(actual.next, end);
            }
            next = end;
          }
          assert.equal(next, stored.length, 'every byte belongs to exactly one complete file range');
        };
        if (gitlink) {
          const posts = [];
          const github = {
            token: 'fixture-token-not-real',
            async request(path, options) {
              if (options?.method === 'POST') {
                posts.push({ path, body: options.body });
                return { id: posts.length };
              }
              return { state: 'open', changed_files: names.length, head: { sha: head }, base: { sha: base, repo: { clone_url: pathToFileURL(cwd).href } } };
            },
            async list() { return names.map(filename => ({ filename, patch: null })); },
          };
          let inspected = false;
          // Exercise the production scope command in its disposable checkout,
          // inheriting diff.submodule=log and color.ui=always from Git config.
          await assert.rejects(review({
            request: { repo: 'org/repo', number: 1, requester: 'Alice', preset: 'sol-xhigh', mode: 'full' },
            github,
            env: { ...env, CODJIFLO_APPROVED_USERS: 'alice' },
            reviewer: async ({ prompt: input }) => {
              await inspect(input);
              inspected = true;
              return { verdict: 'INCOMPLETE', summary: 'Evidence inspected; no model analysis performed.', findings: [] };
            },
          }), /Review incomplete/);
          assert.equal(inspected, true);
          assert.equal(posts.filter(post => post.path.endsWith('/reviews')).length, 0);
        } else {
          const queries = [];
          const input = await reviewInput({ preset: { cli: 'codex' }, temp, cwd, git: args => {
            queries.push(args);
            return git(args);
          }, options: { level: 'xhigh', mode: 'full', base, head, scope: base, diff, currentDiff: '[]' } });
          assert.equal(queries.length, 1, 'indexing all type changes uses only the scope numstat query');
          await inspect(input);
        }
      } finally { await rm(temp, { recursive: true, force: true }); }
    });
  }
});

test('empty incremental scope remains navigable when only current PR evidence is large', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-empty-scope-'));
  const api = [{ filename: 'earlier-change', patch: 'x'.repeat(MAX_INLINE_INPUT) }];
  try {
    const input = await reviewInput({
      preset: { cli: 'codex' }, temp, cwd: join(temp, 'repository'),
      options: { level: 'xhigh', mode: 'incremental', base: 'base', head: 'head', scope: 'head', diff: '', currentDiff: JSON.stringify(api) },
      git: async () => '',
    });
    const manifest = manifestOf(input);
    assert.equal(manifest.scopeFiles, 0);
    assert.equal(manifest.scopeBytes, 0);
    assert.equal(await readFile(join(manifest.directory, 'review-scope.diff'), 'utf8'), '');
    const inventory = (await readFile(join(manifest.directory, 'inventory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].scope, undefined);
    const patches = await readFile(join(manifest.directory, 'pr-patches.json'));
    const range = inventory[0].api;
    assert.deepEqual(JSON.parse(patches.subarray(range.start, range.start + range.bytes)), api[0]);
    await assert.rejects(reviewInput({
      preset: { cli: 'codex' }, temp, cwd: join(temp, 'repository'),
      options: { level: 'xhigh', mode: 'incremental', base: 'base', head: 'head', scope: 'head', diff: 'unindexed data', currentDiff: JSON.stringify(api) },
      git: async () => '',
    }), /index complete/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unbounded inventory records and inconsistent scope indices fail closed', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-inventory-test-'));
  const options = { level: 'xhigh', mode: 'full', base: 'a', head: 'b', scope: 'a', diff: 'diff --git a/a b/a\n' + 'x'.repeat(600000), currentDiff: '[]' };
  try {
    await assert.rejects(reviewInput({ preset: { cli: 'codex' }, options, temp, cwd: join(temp, 'repository'), git: async () => `1\t0\t${'name'.repeat(2000)}\0` }), /inventory record/);
    await assert.rejects(reviewInput({ preset: { cli: 'codex' }, options, temp, cwd: join(temp, 'repository'), git: async () => '' }), /index complete/);
    await assert.rejects(reviewInput({ preset: { cli: 'codex' }, options, temp, cwd: temp, git: async () => '' }), /outside the checkout/);
    for (const diff of [
      'unindexed prefix\n' + options.diff,
      options.diff + '\ndiff --git a/another b/another\nnew block\n',
      options.diff + '\ndiff --git a/a b/a \nnear-identical header\n',
      options.diff + '\ndiff --git a/other b/other\nmiddle block\ndiff --git a/a b/a\nnonconsecutive repeat\n',
    ]) {
      await assert.rejects(reviewInput({ preset: { cli: 'codex' }, options: { ...options, diff }, temp, cwd: join(temp, 'repository'), git: async () => '1\t0\ta\0' }), /index complete/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Codex reconnect errors followed by turn.completed publish the completed review', async () => {
  const f = await fixture();
  try {
    const output = await f.run({ mode: 'reconnect-recovered' });
    assert.match(output, /Reconnecting/);
    assert.equal(verdicts(f).length, 1);
    assert.equal(verdicts(f)[0].body.event, 'APPROVE');
  } finally { await f.close(); }
});

test('Codex failed or missing terminal completion cannot publish a valid-looking result file', async t => {
  for (const mode of ['failed-turn', 'reconnect-failed', 'fatal-error', 'fatal-exit', 'missing-completion', 'input-too-large']) await t.test(mode, async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.run({ mode }), error => {
        if (mode === 'fatal-exit') {
          assert.match(error.stdout, /Fixture fatal transport error/);
          assert.match(error.message, /Fixture verbose CLI stderr detail/);
        }
        return true;
      });
      assert.equal(verdicts(f).length, 0);
      const failure = f.state.posts.at(-1).body.body;
      assert.match(failure, /failed/);
      if (mode === 'reconnect-failed') {
        assert.match(failure, /Reconnecting/);
        assert.match(failure, /Fixture provider failed/);
      }
      if (mode === 'fatal-error' || mode === 'fatal-exit') assert.match(failure, /Fixture fatal transport error/);
      if (mode === 'input-too-large') {
        assert.match(failure, /1048576/);
      }
    } finally { await f.close(); }
  });
});

test('nonzero Codex CLI posts only redacted protocol diagnostics, never tool/model output or stderr', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ mode: 'fatal-exit' }), error => {
      assert.match(error.stdout, /HOST-TOOL-SECRET-do-not-publish/);
      assert.match(error.stdout, /PRIVATE-MODEL-TEXT-do-not-publish/);
      assert.match(error.message, /STDERR-HOST-SECRET-do-not-publish/);
      return true;
    });
    assert.equal(verdicts(f).length, 0);
    const body = f.state.posts.at(-1).body.body;
    assert.match(body, /Codex review failed \(exit 1\)/);
    assert.match(body, /Fixture fatal transport error/);
    assert.match(body, /Fixture safe terminal diagnostic token=\[REDACTED\]/);
    assert.doesNotMatch(body, /HOST-TOOL-SECRET|PRIVATE-MODEL-TEXT|ERROR-EXTRA-SECRET|STDERR-HOST-SECRET|fixture-token-not-real|verbose CLI stderr/);
  } finally { await f.close(); }
});

test('nonzero Codex CLI without protocol diagnostics uses a safe fixed fallback', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ mode: 'raw-exit' }));
    assert.equal(verdicts(f).length, 0);
    const body = f.state.posts.at(-1).body.body;
    assert.match(body, /Codex review failed \(exit 7\)\. See process logs for details/);
    assert.doesNotMatch(body, /RAW-STDOUT-SECRET|STDERR-HOST-SECRET/);
  } finally { await f.close(); }
});

test('non-JSON Codex stdout fails closed even with completion and a valid result', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ mode: 'non-json-completed' }));
    assert.equal(verdicts(f).length, 0);
    const body = f.state.posts.at(-1).body.body;
    assert.match(body, /invalid JSONL protocol output/);
    assert.doesNotMatch(body, /BANNER-SECRET/);
  } finally { await f.close(); }
});

test('a 3000-file inventory stays navigable without inflating the initial prompt', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codjiflo-many-files-'));
  const names = Array.from({ length: 3000 }, (_, index) => `directory/file-${index}.js`);
  const options = {
    level: 'xhigh', mode: 'full', base: 'a', head: 'b', scope: 'a',
    diff: names.map((name, index) => `diff --git a/${name} b/${name}\n${index === 0 ? '+' + 'x'.repeat(600000) + '\n' : ''}`).join(''),
    currentDiff: JSON.stringify(names.map(filename => ({ filename, patch: null }))),
  };
  try {
    const input = await reviewInput({ preset: { cli: 'codex' }, options, temp, cwd: join(temp, 'repository'), git: async () => names.map(name => `0\t0\t${name}\0`).join('') });
    const manifest = manifestOf(input);
    assert.ok(input.length < 16000);
    assert.equal(manifest.scopeFiles, 3000);
    assert.equal(manifest.apiFiles, 3000);
    const inventory = await readFile(join(manifest.directory, 'inventory.jsonl'), 'utf8');
    const records = inventory.trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(record => record.filename), names);
    const last = records.at(-1);
    const anchor = await readRange(manifest.directory, 'pr-patches.json', last.api.start, last.api.bytes);
    assert.deepEqual(JSON.parse(anchor.text), { filename: names.at(-1), patch: null });
    const late = await readRange(manifest.directory, 'review-scope.diff', records[2999].scope.start);
    assert.equal(late.text, `diff --git a/${names.at(-1)} b/${names.at(-1)}\n`);
    // Simulate retrying a truncated read with a smaller budget at the SAME
    // offset, without losing the start of a record or advancing the cursor.
    const large = await readRange(manifest.directory, 'inventory.jsonl', 0);
    const retry = await readRange(manifest.directory, 'inventory.jsonl', 0, 99);
    assert.ok(large.text.startsWith(retry.text));
    assert.equal(retry.start, 0);
    assert.ok(retry.next < large.next);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
