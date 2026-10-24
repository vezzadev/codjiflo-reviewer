import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/runner.mjs';

const cli = fileURLToPath(new URL('../bin/codjiflo-reviewer.mjs', import.meta.url));

test('executable workflow gate authorizes only the original approved comment author', async t => {
  for (const [author, approved, expected] of [
    ['ALICE', 'alice,bob', 'true'],
    ['stranger', 'alice,bob', 'false'],
    ['alice', '', 'false'],
  ]) await t.test(`${author} with ${approved || 'empty allowlist'}`, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codjiflo-gate-'));
    try {
      const eventPath = join(temp, 'event.json');
      const outputPath = join(temp, 'output');
      await writeFile(eventPath, JSON.stringify({
        action: 'created', sender: { login: 'alice' },
        repository: { full_name: 'org/repo' }, issue: { number: 1, pull_request: {} },
        comment: { user: { login: author }, body: '@codjiflo-reviewer review' },
      }));
      await runProcess(process.execPath, [cli, '--gate', '--requester', 'alice'], {
        env: {
          ...process.env, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath, GITHUB_ACTOR: 'alice', GITHUB_TRIGGERING_ACTOR: 'alice',
          GITHUB_TOKEN: '', GH_TOKEN: '', CODJIFLO_APPROVED_USERS: approved,
        },
      });
      const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => line.split('=')));
      assert.equal(outputs.allowed, expected);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
