#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { requestFromEvent, isApproved, PRESETS } from '../src/commands.mjs';
import { GitHub } from '../src/github.mjs';
import { review } from '../src/review.mjs';

try {
  const { values } = parseArgs({ options: {
    gate: { type: 'boolean' }, help: { type: 'boolean' },
    repo: { type: 'string' }, pr: { type: 'string' }, requester: { type: 'string' },
    preset: { type: 'string', default: 'sol-high' }, full: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node bin/codjiflo-reviewer.mjs [--gate]\nEvent mode: GITHUB_EVENT_PATH + CODJIFLO_APPROVED_USERS\nLocal mode: --repo owner/repo --pr N --requester login [--preset sol-high|opus-high|sol-medium|opus-medium] [--full]');
  } else {
    let request;
    if (process.env.GITHUB_EVENT_PATH) {
      if (process.env.GITHUB_EVENT_NAME && process.env.GITHUB_EVENT_NAME !== 'issue_comment') throw new Error('Only issue_comment events are supported');
      request = requestFromEvent(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env.CODJIFLO_APPROVED_USERS);
    } else {
      if (values.gate) throw new Error('Gate requires a GitHub event');
      if (!values.repo || !/^\d+$/.test(values.pr ?? '') || Number(values.pr) < 1 || !isApproved(values.requester, process.env.CODJIFLO_APPROVED_USERS) || !Object.hasOwn(PRESETS, values.preset)) throw new Error('Valid --repo, --pr, --requester and approved-user configuration required');
      request = { repo: values.repo, number: Number(values.pr), requester: values.requester, preset: values.preset, mode: values.full ? 'full' : 'incremental' };
    }
    if (values.gate) {
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `allowed=${Boolean(request)}\n`);
      console.log(request ? 'Approved review request' : 'Ignoring unauthorized or non-review comment');
    } else if (request) {
      const github = new GitHub({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, url: process.env.GITHUB_API_URL });
      await review({ request, github });
    } else console.log('Ignoring unauthorized or non-review comment');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
