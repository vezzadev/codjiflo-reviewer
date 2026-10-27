import { constants } from 'node:fs';
import { cp, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock } from '../src/file-lock.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const referenceDirs = ['types', 'enums', 'docs', 'examples', 'index'];
const skillName = 'developing-solidworks';
const marker = '.bundle-version';


// Plugin registries can be observed while their writer is replacing JSON.
// Retry reads, never use stale cache metadata or relax identity/readiness checks.
async function readJson(load, description) {
  for (let attempt = 1; ; attempt++) {
    const text = await load();
    try {
      return JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (attempt === 3) throw new Error(`${description} is invalid JSON after ${attempt} attempts: ${error.message}`);
      console.warn(`${description} returned invalid JSON; retrying (${attempt}/3)`);
      await delay(250);
    }
  }
}
async function hasReferenceFile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && (await lstat(file)).size > 0) return true;
    if (entry.isDirectory() && await hasReferenceFile(file)) return true;
  }
  return false;
}

async function bundleVersion(skill) {
  try {
    const version = (await readFile(path.join(skill, marker), 'utf8')).trim();
    if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return null;
    for (const directory of referenceDirs) {
      const location = path.join(skill, directory);
      if (!(await lstat(location)).isDirectory() || !await hasReferenceFile(location)) return null;
    }
    return version;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

async function resolveTarget(home) {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));
  const registry = await readJson(async () => {
    const { stdout } = await execFileAsync(process.env.CODJIFLO_CODEX_BIN || 'codex', ['plugin', 'list', '--json'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }, 'Codex plugin manifest');
  const active = registry.installed?.filter(plugin => plugin.name === skillName && plugin.installed === true && plugin.enabled === true);
  if (!Array.isArray(active) || active.length !== 1) throw new Error('Expected exactly one installed, enabled Codex developing-solidworks plugin');
  const plugin = active[0];
  for (const value of [plugin.marketplaceName, plugin.version]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
      throw new Error('Invalid Codex plugin marketplace or version');
    }
  }
  const pluginKey = `${skillName}@${plugin.marketplaceName}`;
  if (plugin.pluginId !== pluginKey) throw new Error('Inconsistent Codex developing-solidworks plugin identity');
  const target = path.join(codexHome, 'plugins', 'cache', plugin.marketplaceName, skillName, plugin.version, 'skills', skillName);
  if (!(await lstat(target)).isDirectory()) throw new Error(`Missing Codex skill directory: ${target}`);
  return { target, pluginKey };
}

async function resolveSource(home, pluginKey) {
  const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  let installed;
  try {
    installed = await readJson(() => readFile(registry, 'utf8'), 'Claude installed-plugin registry');
  } catch (error) {
    throw new Error(`No readable Claude installed-plugin registry at ${registry}: ${error.message}`);
  }
  const entries = installed.plugins?.[pluginKey];
  if (!Array.isArray(entries)) throw new Error(`No installed Claude ${pluginKey} bundle in ${registry}`);
  const candidates = [...entries].sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')));
  for (const entry of candidates) {
    if (typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) continue;
    const source = path.join(entry.installPath, 'skills', skillName);
    const version = await bundleVersion(source);
    if (version) return { source, version };
  }
  throw new Error(`No complete Claude ${pluginKey} bundle: require a valid ${marker} and nonempty ${referenceDirs.join(', ')} directories`);
}


async function prepare(home) {
  const { target, pluginKey } = await resolveTarget(home);
  const lock = `${target}.prepare-lock`;
  const handle = await acquireLock(lock);
  let staging;
  try {
    await handle.writeFile(`pid=${process.pid}\n`);
    const readyVersion = await bundleVersion(target);
    if (readyVersion) {
      console.log(`SolidWorks docs reused target=${target} version=${readyVersion}`);
      return;
    }
    const { source, version } = await resolveSource(home, pluginKey);
    staging = await mkdtemp(`${target}.prepare-`);
    for (const directory of referenceDirs) {
      await cp(path.join(source, directory), path.join(staging, directory), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        dereference: true,
      });
    }
    await writeFile(path.join(staging, marker), `${version}\n`);
    if (await bundleVersion(staging) !== version) throw new Error('Copied SolidWorks reference failed readiness validation');
    // Invalidate any partial target before replacing its reference directories.
    // Other preparers cannot report success while this exclusive lock is held.
    await rm(path.join(target, marker), { force: true });
    for (const directory of referenceDirs) {
      await rm(path.join(target, directory), { recursive: true, force: true });
      await rename(path.join(staging, directory), path.join(target, directory));
    }
    await rename(path.join(staging, marker), path.join(target, marker));
    console.log(`SolidWorks docs provisioned target=${target} version=${version}`);
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      await handle.close();
      await rm(lock, { force: true });
    }
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--home' || !args[1])) throw new Error('Usage: node scripts/prepare-solidworks-docs.mjs [--home PATH]');
  await prepare(path.resolve(args[1] ?? homedir()));
} catch (error) {
  console.error(`SolidWorks docs preparation failed: ${error.message}`);
  process.exitCode = 1;
}
