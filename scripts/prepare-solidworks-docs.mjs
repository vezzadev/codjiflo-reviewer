import { constants } from 'node:fs';
import { cp, lstat, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const referenceDirs = ['types', 'enums', 'docs', 'examples', 'index'];
const skillName = 'developing-solidworks';
const marker = '.bundle-version';

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
  const { stdout } = await execFileAsync(process.env.CODJIFLO_CODEX_BIN || 'codex', ['plugin', 'list', '--json'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const registry = JSON.parse(stdout);
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
    installed = JSON.parse(await readFile(registry, 'utf8'));
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

async function acquireLock(lock) {
  const deadline = performance.now() + 30000;
  let unidentifiedSince;
  let waiting = false;
  const stale = () => new Error(`Preparation lock exists: ${lock}. Its owner is dead or unidentified; confirm no preparation is running, remove this stale lock and retry.`);
  while (true) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for SolidWorks docs preparation lock: ${lock}. Owner may still be running; do not remove a live owner's lock.`);
    try {
      return await open(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let contents;
    try {
      contents = await readFile(lock, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        unidentifiedSince = undefined;
        continue;
      }
      throw error;
    }
    const match = contents.match(/^pid=([1-9]\d*)\n$/);
    const pid = match && Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) {
      // open('wx') and writing the PID are separate operations.
      unidentifiedSince ??= performance.now();
      if (performance.now() - unidentifiedSince >= 1000) throw stale();
    } else {
      unidentifiedSince = undefined;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          // The previous owner may have released and exited after our read.
          try {
            if (await readFile(lock, 'utf8') !== contents) continue;
          } catch (readError) {
            if (readError.code === 'ENOENT') continue;
            throw readError;
          }
          throw stale();
        }
        if (error.code !== 'EPERM') throw error;
      }
    }
    if (!waiting) {
      console.log(`SolidWorks docs waiting for preparation lock=${lock}`);
      waiting = true;
    }
    await delay(100);
  }
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
