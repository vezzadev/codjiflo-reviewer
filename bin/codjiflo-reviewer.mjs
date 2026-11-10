#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { COMMAND_SYNTAX, commentEvent, eventDecision, isApproved, normalizePreset, PRESETS } from '../src/commands.mjs';
import { GitHub } from '../src/github.mjs';
import { review } from '../src/review.mjs';
import { publishReview, reportPublicationFailure } from '../src/publication.mjs';
import { repositorySettings } from '../src/repositories.mjs';

async function reportGate(event, decision, github) {
  const { request, reason } = decision;
  const provider = request ? PRESETS[request.preset].provider : 'none';
  const token = value => String(value ?? 'unknown').replace(/\s/g, '_');
  const line = `gate: allowed=${Boolean(request)} reason=${reason}${request ? ` provider=${provider} preset=${request.preset} mode=${request.mode}` : ''} author=${token(event.comment?.user?.login)} comment=${token(event.comment?.id)} pr=${event.issue?.pull_request ? `#${token(event.issue.number)}` : 'none'}`;
  console.log(line);
  const outputs = [`allowed=${Boolean(request)}`, `provider=${provider}`];
  if (request) {
    const settings = repositorySettings(JSON.parse(await readFile(new URL('../repositories.json', import.meta.url), 'utf8')), request.repo);
    // Anything but an explicit public answer keeps reviewed content out of this repository's logs and artifacts.
    const visibility = (await github.request(`/repos/${request.repo}`))?.private === false ? 'public' : 'private';
    outputs.push(`number=${request.number}`, `visibility=${visibility}`, `prepare-command=${settings.prepareCommand}`, `source-submodules=${JSON.stringify(settings.sourceSubmodules)}`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Codjiflo gate\n\n<pre>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>\n`);
}

try {
  const { values } = parseArgs({ options: {
    gate: { type: 'boolean' }, help: { type: 'boolean' },
    repo: { type: 'string' }, pr: { type: 'string' }, requester: { type: 'string' }, comment: { type: 'string' },
    preset: { type: 'string' }, full: { type: 'boolean' },
    publish: { type: 'string' }, output: { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node bin/codjiflo-reviewer.mjs\nMention mode: --repo owner/repo --comment ID [--gate] [--output FILE] (authorizes the comment author against CODJIFLO_APPROVED_USERS)\nLocal mode: --repo owner/repo --pr N --requester login [--preset opus-xhigh|opus-medium|claude] [--full] [--output FILE]\nPublication-only recovery: --publish FILE');
  } else if (values.publish) {
    if (values.gate || values.repo || values.pr || values.requester || values.comment || values.full || values.output) throw new Error('--publish cannot be combined with review options');
    const envelope = JSON.parse(await readFile(values.publish, 'utf8'));
    const github = new GitHub({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, url: process.env.GITHUB_API_URL });
    try { await publishReview({ envelope, github }); }
    catch (error) {
      if (envelope?.request && isApproved(envelope.request.requester, process.env.CODJIFLO_APPROVED_USERS)) await reportPublicationFailure({ request: envelope.request, github, error });
      throw error;
    }
  } else {
    const github = new GitHub({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, url: process.env.GITHUB_API_URL });
    let request;
    if (values.comment) {
      if (values.pr || values.requester || values.preset || values.full) throw new Error('--comment cannot be combined with local review options');
      const event = await commentEvent(github, values.repo, values.comment);
      const decision = eventDecision(event, process.env.CODJIFLO_APPROVED_USERS);
      if (values.gate) await reportGate(event, decision, github);
      // An approved author who mistyped a command gets the answer where they asked, not only in this run's log.
      // Best effort: the gate must still fail with the command error. Inline code keeps the syntax from mentioning anyone.
      if (values.gate && decision.error) {
        await github.request(`/repos/${values.repo}/issues/${event.issue.number}/comments`, { method: 'POST', body: { body: `Codjiflo Reviewer did not start: invalid review command. Use ${COMMAND_SYNTAX.map(form => `\`${form}\``).join(' or ')}.` } })
          .catch(error => console.error(`Could not post the invalid-command reply: ${error.message}`));
      }
      if (decision.error) throw decision.error;
      request = decision.request;
    } else {
      if (values.gate) throw new Error('Gate requires --comment');
      const preset = normalizePreset(values.preset ?? 'opus-xhigh');
      if (!values.repo || !/^\d+$/.test(values.pr ?? '') || Number(values.pr) < 1 || !isApproved(values.requester, process.env.CODJIFLO_APPROVED_USERS) || !preset) throw new Error('Valid --repo, --pr, --requester and approved-user configuration required');
      request = { repo: values.repo, number: Number(values.pr), requester: values.requester, preset, mode: values.full ? 'full' : 'incremental' };
    }
    if (values.gate) {
      // The decision is already reported; nothing else runs in the gate.
    } else if (request) await review({ request, github, output: values.output });
    // The gate accepted this comment earlier: a different answer now means it was edited or deleted.
    else throw new Error('Comment no longer requests an approved review');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
