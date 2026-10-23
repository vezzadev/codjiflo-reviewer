export const PRESETS = {
  'sol-xhigh': { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', level: 'xhigh' },
  'opus-xhigh': { cli: 'claude', model: 'opus', effort: 'high', level: 'xhigh' },
  'sol-medium': { cli: 'codex', model: 'gpt-6.1-sol', effort: 'medium', level: 'high' },
  'opus-medium': { cli: 'claude', model: 'opus', effort: 'medium', level: 'high' },
};

export function normalizePreset(value) {
  const name = value.toLowerCase();
  if (name === 'codex') return 'sol-xhigh';
  if (name === 'claude') return 'opus-xhigh';
  return Object.hasOwn(PRESETS, name) ? name : null;
}

export function isApproved(login, configured = '') {
  const users = configured.split(/[,\s]+/).filter(Boolean).map(value => value.toLowerCase());
  return typeof login === 'string' && users.includes(login.toLowerCase());
}

export function parseCommand(body) {
  const mentions = /(?:^|\n)[^\S\n]*@codjiflo(?:-reviewer)?[^\S\n]+(\S+)([^\n]*)/gi;
  for (const match of (body ?? '').matchAll(mentions)) {
    const first = match[1].toLowerCase();
    if (first !== 'review' && !normalizePreset(first)) continue;
    const words = (first === 'review' ? match[2] : `${first}${match[2]}`).trim().split(/\s+/).filter(Boolean);
    let preset = 'sol-xhigh';
    let mode = 'incremental';
    const seen = new Set();
    for (const word of words) {
      const value = word.toLowerCase();
      const canonical = normalizePreset(value);
      const kind = canonical ? 'preset' : ['full', 'incremental'].includes(value) ? 'mode' : null;
      if (!kind || seen.has(kind)) throw new Error(`Invalid review command: ${body}. Use @codjiflo review [sol-xhigh|opus-xhigh|sol-medium|opus-medium|codex|claude] [full|incremental] or @codjiflo <preset> [full|incremental]`);
      seen.add(kind);
      if (kind === 'preset') preset = canonical;
      else mode = value;
    }
    return { preset, mode };
  }
  return null;
}

export function requestFromEvent(event, approved) {
  if (!event.issue?.pull_request || event.action !== 'created') return null;
  // The original comment author, never the workflow rerunner, is authoritative.
  if (!isApproved(event.comment?.user?.login, approved)) return null;
  const command = parseCommand(event.comment?.body);
  if (!command) return null;
  return { ...command, repo: event.repository.full_name, number: event.issue.number, requester: event.comment.user.login };
}
