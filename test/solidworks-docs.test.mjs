import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/prepare-solidworks-docs.mjs', import.meta.url));
const dirs = ['types', 'enums', 'docs', 'examples', 'index'];
const skill = 'developing-solidworks';
const pluginKey = `${skill}@agent-plugins`;

async function put(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function bundle(root, version = 'v3.12.1') {
  for (const dir of dirs) {
    const name = dir === 'types' ? 'IModelDoc2.md' : dir === 'enums' ? 'swDocumentTypes_e.md' : 'reference.md';
    await put(path.join(root, dir, name), `${dir} offline reference\n`);
  }
  await put(path.join(root, '.bundle-version'), `${version}\n`);
}

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'solidworks-docs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const cli = path.join(home, 'codex-fixture.mjs');
  await writeFile(cli, `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['plugin', 'list', '--json'])) process.exit(2);\nprocess.stdout.write(readFileSync(process.env.CODEX_HOME + '/active.json', 'utf8'));\n`, { mode: 0o755 });
  const targetFor = version => path.join(codexHome, 'plugins', 'cache', 'agent-plugins', skill, version, 'skills', skill);
  const activate = async (version = '0.9.9') => {
    await put(path.join(codexHome, 'active.json'), JSON.stringify({
      installed: [{ pluginId: pluginKey, name: skill, marketplaceName: 'agent-plugins', version, installed: true, enabled: true,
        source: { source: 'local', path: '/not-the-runtime-cache' } }], available: [],
    }));
    await put(path.join(targetFor(version), 'SKILL.md'), 'Keep the existing skill instructions.\n');
    return targetFor(version);
  };
  const target = await activate();
  const sourcePlugin = path.join(home, '.claude', 'plugins', 'cache', 'agent-plugins', skill, '0.9.9');
  const source = path.join(sourcePlugin, 'skills', skill);
  const registerSource = async () => {
    await put(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { [pluginKey]: [{ scope: 'project', projectPath: '/some/other/project', installPath: sourcePlugin, version: '0.9.9', lastUpdated: '2026-09-27T00:26:34.503Z' }] },
    }));
  };
  const run = () => execFileAsync(process.execPath, [script, '--home', home], {
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome, CODJIFLO_CODEX_BIN: cli }, timeout: 10000,
  });
  return { home, codexHome, target, targetFor, source, activate, registerSource, run };
}

async function noMarker(target) {
  await assert.rejects(readFile(path.join(target, '.bundle-version')), { code: 'ENOENT' });
}

for (const defect of ['missing source', 'empty source', 'missing marker', 'invalid marker', 'partial directories', 'empty reference directory']) {
  test(`fails closed for ${defect}`, async t => {
    const f = await fixture(t);
    if (defect !== 'missing source') {
      await f.registerSource();
      if (defect === 'empty source') await mkdir(f.source, { recursive: true });
      else {
        await bundle(f.source);
        if (defect === 'missing marker') await rm(path.join(f.source, '.bundle-version'));
        if (defect === 'invalid marker') await put(path.join(f.source, '.bundle-version'), 'ready');
        if (defect === 'partial directories') await rm(path.join(f.source, 'enums'), { recursive: true });
        if (defect === 'empty reference directory') {
          await rm(path.join(f.source, 'types'), { recursive: true });
          await put(path.join(f.source, 'types', 'empty.md'), '');
        }
      }
    }
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /SolidWorks docs preparation failed:/);
      assert.doesNotMatch(error.stdout, /provisioned|reused/);
      return true;
    });
    await noMarker(f.target);
    assert.equal(await readFile(path.join(f.target, 'SKILL.md'), 'utf8'), 'Keep the existing skill instructions.\n');
    assert.deepEqual(await readdir(path.dirname(f.target)), [skill]);
  });
}

test('copies all reference directories and real enum/type files, preserving unrelated skill files', async t => {
  const f = await fixture(t);
  await f.registerSource();
  await bundle(f.source);
  await put(path.join(f.source, 'SKILL.md'), 'Do not replace target instructions');
  await put(path.join(f.source, 'scripts', 'source-only.ps1'), 'Do not copy me');
  await put(path.join(f.target, 'learnings', 'notes.md'), 'user notes');
  await put(path.join(f.target, 'scripts', 'custom.ps1'), 'user script');
  await put(path.join(f.target, 'docs', 'obsolete.md'), 'partial previous attempt');
  const result = await f.run();
  assert.match(result.stdout, /SolidWorks docs provisioned target=.* version=v3\.12\.1/);
  for (const directory of dirs) assert.deepEqual(await readdir(path.join(f.target, directory)), await readdir(path.join(f.source, directory)));
  assert.equal(await readFile(path.join(f.target, 'types', 'IModelDoc2.md'), 'utf8'), 'types offline reference\n');
  assert.equal(await readFile(path.join(f.target, 'enums', 'swDocumentTypes_e.md'), 'utf8'), 'enums offline reference\n');
  assert.equal(await readFile(path.join(f.target, '.bundle-version'), 'utf8'), 'v3.12.1\n');
  assert.equal(await readFile(path.join(f.target, 'SKILL.md'), 'utf8'), 'Keep the existing skill instructions.\n');
  assert.equal(await readFile(path.join(f.target, 'learnings', 'notes.md'), 'utf8'), 'user notes');
  assert.deepEqual(await readdir(path.join(f.target, 'scripts')), ['custom.ps1']);
  assert.deepEqual(await readdir(path.dirname(f.target)), [skill]);
});

test('reuses a complete target without any Claude installation or repeated writes', async t => {
  const f = await fixture(t);
  await bundle(f.target);
  const marker = path.join(f.target, '.bundle-version');
  const before = await stat(marker);
  for (let attempt = 0; attempt < 2; attempt++) assert.match((await f.run()).stdout, /SolidWorks docs reused/);
  const after = await stat(marker);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
});

test('selects the active plugin version from CLI metadata, not an older or newer cache', async t => {
  const f = await fixture(t);
  await bundle(f.target, 'v1.0.0');
  await bundle(f.targetFor('99.0.0'), 'v99.0.0');
  const activeTarget = await f.activate('1.2.0');
  await f.registerSource();
  await bundle(f.source);
  const result = await f.run();
  assert.ok(result.stdout.includes(`target=${activeTarget} version=v3.12.1`));
  assert.equal(await readFile(path.join(activeTarget, '.bundle-version'), 'utf8'), 'v3.12.1\n');
  assert.equal(await readFile(path.join(f.target, '.bundle-version'), 'utf8'), 'v1.0.0\n');
  assert.equal(await readFile(path.join(f.targetFor('99.0.0'), '.bundle-version'), 'utf8'), 'v99.0.0\n');
});

test('rejects a partial target even with a plausible marker when no source is available', async t => {
  const f = await fixture(t);
  await bundle(f.target);
  await rm(path.join(f.target, 'enums'), { recursive: true });
  await assert.rejects(f.run(), error => error.code === 1 && /No readable Claude/.test(error.stderr));
});

test('exclusive lock prevents reporting readiness while a writer owns the target; stale lock fails explicitly', async t => {
  const f = await fixture(t);
  await bundle(f.target);
  const marker = path.join(f.target, '.bundle-version');
  const lock = `${f.target}.prepare-lock`;
  await put(lock, 'pid=999999999\n');
  await assert.rejects(f.run(), error => {
    assert.match(error.stderr, /Preparation lock exists:.*remove this stale lock and retry/);
    assert.doesNotMatch(error.stdout, /reused|provisioned/);
    return true;
  });
  assert.equal(await readFile(marker, 'utf8'), 'v3.12.1\n');
  await rm(lock);
  assert.match((await f.run()).stdout, /SolidWorks docs reused/);
});

test('rejects CLI metadata selecting a nonexistent active cache rather than falling back', async t => {
  const f = await fixture(t);
  const target = await f.activate('2.0.0');
  await rm(target, { recursive: true });
  await bundle(f.target);
  await assert.rejects(f.run(), error => error.code === 1 && /SolidWorks docs preparation failed:/.test(error.stderr));
});

for (const selection of ['disabled', 'ambiguous', 'invalid version']) {
  test(`rejects ${selection} active-plugin metadata without modifying the target`, async t => {
    const f = await fixture(t);
    const registryPath = path.join(f.codexHome, 'active.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    if (selection === 'disabled') registry.installed[0].enabled = false;
    if (selection === 'ambiguous') registry.installed.push({ ...registry.installed[0] });
    if (selection === 'invalid version') registry.installed[0].version = '../escape';
    await put(registryPath, JSON.stringify(registry));
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /SolidWorks docs preparation failed:/);
      return true;
    });
    await noMarker(f.target);
  });
}
