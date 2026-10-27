#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { eventDecision, isApproved, normalizePreset, PRESETS } from '../src/commands.mjs';
import { GitHub } from '../src/github.mjs';
import { review } from '../src/review.mjs';
import { publishReview, reportPublicationFailure } from '../src/publication.mjs';

async function reportGate(event, decision) {
  const { request, reason } = decision;
  const provider = request ? PRESETS[request.preset].cli : 'none';
  const token = value => String(value ?? 'unknown').replace(/\s/g, '_');
  const line = `gate: allowed=${Boolean(request)} reason=${reason}${request ? ` provider=${provider} preset=${request.preset} mode=${request.mode}` : ''} author=${token(event.comment?.user?.login)} comment=${token(event.comment?.id)} pr=${event.issue?.pull_request ? `#${token(event.issue.number)}` : 'none'}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `allowed=${Boolean(request)}\nprovider=${provider}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Codjiflo gate\n\n<pre>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>\n`);
}

try {
  const { values } = parseArgs({ options: {
    gate: { type: 'boolean' }, help: { type: 'boolean' },
    repo: { type: 'string' }, pr: { type: 'string' }, requester: { type: 'string' },
    preset: { type: 'string', default: 'sol-xhigh' }, full: { type: 'boolean' },
    publish: { type: 'string' }, output: { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node bin/codjiflo-reviewer.mjs [--gate]\nEvent mode: GITHUB_EVENT_PATH + CODJIFLO_APPROVED_USERS\nLocal mode: --repo owner/repo --pr N --requester login [--preset sol-xhigh|opus-xhigh|sol-medium|opus-medium|codex|claude] [--full] [--output FILE]\nPublication-only recovery: --publish FILE');
  } else if (values.publish) {
    if (values.gate || values.repo || values.pr || values.requester || values.full || values.output) throw new Error('--publish cannot be combined with review options');
    const envelope = JSON.parse(await readFile(values.publish, 'utf8'));
    const github = new GitHub({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, url: process.env.GITHUB_API_URL });
    try { await publishReview({ envelope, github }); }
    catch (error) {
      if (envelope?.request && isApproved(envelope.request.requester, process.env.CODJIFLO_APPROVED_USERS)) await reportPublicationFailure({ request: envelope.request, github, error });
      throw error;
    }
  } else {
    let request;
    if (process.env.GITHUB_EVENT_PATH) {
      if (process.env.GITHUB_EVENT_NAME && process.env.GITHUB_EVENT_NAME !== 'issue_comment') throw new Error('Only issue_comment events are supported');
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const decision = eventDecision(event, process.env.CODJIFLO_APPROVED_USERS);
      if (values.gate) await reportGate(event, decision);
      if (decision.error) throw decision.error;
      request = decision.request;
    } else {
      if (values.gate) throw new Error('Gate requires a GitHub event');
      const preset = normalizePreset(values.preset);
      if (!values.repo || !/^\d+$/.test(values.pr ?? '') || Number(values.pr) < 1 || !isApproved(values.requester, process.env.CODJIFLO_APPROVED_USERS) || !preset) throw new Error('Valid --repo, --pr, --requester and approved-user configuration required');
      request = { repo: values.repo, number: Number(values.pr), requester: values.requester, preset, mode: values.full ? 'full' : 'incremental' };
    }
    if (!values.gate && request) {
      const github = new GitHub({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, url: process.env.GITHUB_API_URL });
      await review({ request, github, output: values.output });
    } else if (!values.gate) console.log('Ignoring unauthorized or non-review comment');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
