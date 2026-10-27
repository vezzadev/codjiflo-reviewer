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

test('gate explains every decision in logs and the Actions summary without starting review work', async t => {
  const cases = [
    { name: 'embedded command', body: 'Owner authorized option (A). @codjiflo codex', allowed: true, reason: 'approved', provider: 'codex', preset: 'sol-xhigh', mode: 'incremental' },
    { name: 'Claude full command', body: 'Please @codjiflo claude full', allowed: true, reason: 'approved', provider: 'claude', preset: 'opus-xhigh', mode: 'full' },
    { name: 'ordinary comment', body: 'Thanks @codjiflo for reviewing', reason: 'not-a-command' },
    { name: 'quoted command', body: '> @codjiflo codex', reason: 'not-a-command' },
    { name: 'bot kickoff', author: 'codjiflo[bot]', type: 'Bot', body: 'Starting review', reason: 'bot-author' },
    { name: 'allowlisted bot command', author: 'codjiflo[bot]', type: 'Bot', approved: 'codjiflo[bot]', body: '@codjiflo codex', reason: 'bot-author' },
    { name: 'bot login without type', author: 'codjiflo[bot]', body: '@codjiflo codex', reason: 'bot-author' },
    { name: 'unapproved command', author: 'stranger', body: '@codjiflo codex', reason: 'not-approved' },
    { name: 'unapproved malformed command', author: 'stranger', body: '@codjiflo review turbo', reason: 'not-approved' },
    { name: 'issue command', pr: false, body: '@codjiflo codex', reason: 'not-a-pr' },
    { name: 'edited command', action: 'edited', body: '@codjiflo codex', reason: 'not-a-command' },
    { name: 'invalid command', body: 'Please @codjiflo review turbo', reason: 'invalid-command', fails: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codjiflo-gate-decision-'));
    try {
      const eventPath = join(temp, 'event.json');
      const outputPath = join(temp, 'output');
      const summaryPath = join(temp, 'summary');
      const author = scenario.author ?? 'alice';
      await writeFile(eventPath, JSON.stringify({
        action: scenario.action ?? 'created',
        repository: { full_name: 'org/repo' },
        issue: { number: 2025, ...(scenario.pr === false ? {} : { pull_request: {} }) },
        comment: { id: 6451172747, user: { login: author, type: scenario.type ?? 'User' }, body: scenario.body },
      }));
      const running = runProcess(process.execPath, [cli, '--gate'], {
        env: {
          ...process.env, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_TOKEN: '', GH_TOKEN: '', CODJIFLO_APPROVED_USERS: scenario.approved ?? 'alice',
          CODJIFLO_CODEX_BIN: '/nonexistent-reviewer', CODJIFLO_CLAUDE_BIN: '/nonexistent-reviewer',
        },
      });
      const allowed = Boolean(scenario.allowed);
      const line = `gate: allowed=${allowed} reason=${scenario.reason}${allowed ? ` provider=${scenario.provider} preset=${scenario.preset} mode=${scenario.mode}` : ''} author=${author} comment=6451172747 pr=${scenario.pr === false ? 'none' : '#2025'}`;
      if (scenario.fails) await assert.rejects(running, /Invalid review command/);
      else assert.equal(await running, `${line}\n`);
      assert.equal(await readFile(outputPath, 'utf8'), `allowed=${allowed}\nprovider=${scenario.provider ?? 'none'}\n`);
      assert.equal(await readFile(summaryPath, 'utf8'), `## Codjiflo gate\n\n<pre>${line}</pre>\n`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
