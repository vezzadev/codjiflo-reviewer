import { open, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// A dead/unidentified owner requires operator intervention: never steal a lock.
export async function acquireLock(lock, {
  label = 'SolidWorks docs preparation',
  staleLabel = 'Preparation',
  onWait = () => console.log(`SolidWorks docs waiting for preparation lock=${lock}`),
} = {}) {
  const deadline = performance.now() + 30000;
  let unidentifiedSince;
  let waiting = false;
  const stale = () => new Error(`${staleLabel} lock exists: ${lock}. Its owner is dead or unidentified; confirm no preparation is running, remove this stale lock and retry.`);
  while (true) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label} lock: ${lock}. Owner may still be running; do not remove a live owner's lock.`);
    try {
      return await open(lock, 'wx', 0o600);
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
      onWait();
      waiting = true;
    }
    await delay(100);
  }
}
