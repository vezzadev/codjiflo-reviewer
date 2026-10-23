export const PRESETS = {
  'sol-high': { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', level: 'xhigh' },
  'opus-high': { cli: 'claude', model: 'opus', effort: 'high', level: 'xhigh' },
  'sol-medium': { cli: 'codex', model: 'gpt-6.1-sol', effort: 'medium', level: 'high' },
  'opus-medium': { cli: 'claude', model: 'opus', effort: 'medium', level: 'high' },
};

export function isApproved(login, configured = '') {
  const users = configured.split(/[,\s]+/).filter(Boolean).map(value => value.toLowerCase());
  // Match configured GitHub logins without regard to case.
  return typeof login === 'string' && users.includes(login.toLowerCase());
}

export function parseCommand(body) {
  const match = /(?:^|\n)\s*@codjiflo(?:-reviewer)?\s+review\b([^\n]*)/i.exec(body ?? '');
  if (!match) return null;
  const words = match[1].trim().split(/\s+/).filter(Boolean);
  let preset = 'sol-high';
  let mode = 'incremental';
  const seen = new Set();
  for (const word of words) {
    const value = word.toLowerCase();
    const kind = Object.hasOwn(PRESETS, value) ? 'preset' : ['full', 'incremental'].includes(value) ? 'mode' : null;
    if (!kind || seen.has(kind)) throw new Error(`Invalid review command: ${body}. Use @codjiflo review [sol-high|opus-high|sol-medium|opus-medium] [full|incremental]`);
    seen.add(kind);
    if (kind === 'preset') preset = value;
    else mode = value;
  }
  return { preset, mode };
}

export function requestFromEvent(event, approved) {
  if (!event.issue?.pull_request || event.action !== 'created') return null;
  // The original comment author, never the workflow rerunner, is authoritative.
  if (!isApproved(event.comment?.user?.login, approved)) return null;
  const command = parseCommand(event.comment?.body);
  if (!command) return null;
  return { ...command, repo: event.repository.full_name, number: event.issue.number, requester: event.comment.user.login };
}
