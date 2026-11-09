import { isDeepStrictEqual } from 'node:util';
import { PRESETS } from './commands.mjs';

const MARKER = /^<!-- codjiflo-reviewer:v4 (\{[^\n]+\}) -->\r?$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const FINDING_FIELDS = ['path', 'side', 'start_line', 'line', 'priority', 'disposition', 'title', 'body'];

export function validFinding(finding) {
  return finding && typeof finding === 'object' && !Array.isArray(finding)
    && ['blocking', 'advisory'].includes(finding.disposition)
    && ['P0', 'P1', 'P2', 'P3'].includes(finding.priority)
    && typeof finding.path === 'string' && finding.path.length > 0
    && ['title', 'body'].every(key => typeof finding[key] === 'string' && finding[key].trim())
    && ['LEFT', 'RIGHT'].includes(finding.side)
    && Number.isSafeInteger(finding.start_line) && finding.start_line > 0
    && Number.isSafeInteger(finding.line) && finding.line >= finding.start_line;
}

function checkpointRecord(body) {
  // Published metadata occupies its own LF- or CRLF-delimited line after the summary.
  // Select the last such record, not an earlier standalone example or quoted prefix.
  return typeof body === 'string' ? body.split('\n').findLast(line => line.startsWith('<!-- codjiflo-reviewer:')) : undefined;
}

export function parseCheckpoint(prior) {
  if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(prior.state)) return null;
  try {
    const match = MARKER.exec(checkpointRecord(prior.body));
    if (!match) return null;
    const value = JSON.parse(match[1]);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'base,findings,head,kickoffId,preset'
        || !Number.isSafeInteger(value.kickoffId) || value.kickoffId <= 0
        || typeof value.head !== 'string' || !SHA.test(value.head) || typeof value.base !== 'string' || !SHA.test(value.base) || value.head !== prior.commit_id
        || typeof value.preset !== 'string' || !Object.hasOwn(PRESETS, value.preset) || !Array.isArray(value.findings)) return null;
    const ids = new Set();
    for (const finding of value.findings) {
      if (!validFinding(finding) || Object.keys(finding).sort().join() !== [...FINDING_FIELDS, 'id', 'originHead'].sort().join()
          || typeof finding.id !== 'string' || !UUID.test(finding.id) || typeof finding.originHead !== 'string' || !SHA.test(finding.originHead) || ids.has(finding.id)) return null;
      ids.add(finding.id);
    }
    const blockers = value.findings.some(finding => finding.disposition === 'blocking');
    if ((prior.state === 'APPROVED' && blockers) || (prior.state === 'CHANGES_REQUESTED' && !blockers)) return null;
    return { prior, value };
  } catch { return null; }
}

export function observeCheckpoints(reviews) {
  let checkpoint = null;
  let conflicted = false;
  let highestKickoffId = 0;
  let barrierFloor = 0;
  for (const prior of reviews) {
    if (checkpointRecord(prior.body) === undefined) continue;
    const candidate = parseCheckpoint(prior);
    if (!candidate) {
      // Invalid/legacy metadata invalidates the ledger, but must not erase the
      // generation already observed. Only a strictly newer analysis clears it.
      barrierFloor = highestKickoffId;
      checkpoint = null;
      conflicted = false;
      continue;
    }
    highestKickoffId = Math.max(highestKickoffId, candidate.value.kickoffId);
    if (candidate.value.kickoffId <= barrierFloor) continue;
    if (!checkpoint || candidate.value.kickoffId > checkpoint.value.kickoffId) {
      checkpoint = candidate;
      conflicted = false;
    } else if (candidate.value.kickoffId === checkpoint.value.kickoffId) {
      // A generation identifies one analysis. Conflicting ledgers cannot be
      // resolved by publication order; identical retries use the latest state.
      conflicted ||= !isDeepStrictEqual(candidate.value, checkpoint.value);
      checkpoint = candidate;
    }
    // Lower generations can be delayed recoveries, not newer analyses.
  }
  return { checkpoint: conflicted ? null : checkpoint, highestKickoffId };
}

export function latestCheckpoint(reviews) {
  return observeCheckpoints(reviews).checkpoint;
}

export function getCheckpointSnapshot(reviews) {
  // Use persisted ledger metadata and submitted state, not receipt identity:
  // equivalent retry receipts represent the same analyzed checkpoint.
  const { checkpoint, highestKickoffId } = observeCheckpoints(reviews);
  return {
    fingerprint: checkpoint ? JSON.stringify({ value: checkpoint.value, state: checkpoint.prior.state }) : null,
    highestKickoffId,
  };
}
