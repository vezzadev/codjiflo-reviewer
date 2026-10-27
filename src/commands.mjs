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

// Ignore Markdown examples while allowing explicit commands after ordinary prose.
function commandText(body) {
  let fence;
  return (body ?? '').split('\n').map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    return line;
  }).join('\n').replace(/(?<!`)(`+)([\s\S]*?)\1(?!`)/g, match => match.replace(/[^\n]/g, ' '));
}

export function parseCommand(body) {
  const text = commandText(body);
  const mentions = /(?:^|[^\w@])@codjiflo(?:-reviewer)?[^\S\n]+(\S+)/gi;
  for (const match of text.matchAll(mentions)) {
    const first = match[1].toLowerCase();
    if (first !== 'review' && !normalizePreset(first)) continue;
    const rest = text.slice(match.index + match[0].length).split('\n', 1)[0];
    const words = (first === 'review' ? rest : `${first}${rest}`).trim().split(/\s+/).filter(Boolean);
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

export function eventDecision(event, approved) {
  if (!event.issue?.pull_request) return { reason: 'not-a-pr' };
  if (event.action !== 'created') return { reason: 'not-a-command' };
  const author = event.comment?.user;
  if (author?.type === 'Bot' || /\[bot\]$/i.test(author?.login ?? '')) return { reason: 'bot-author' };
  // The original comment author, never the workflow rerunner, is authoritative.
  if (!isApproved(author?.login, approved)) return { reason: 'not-approved' };
  let command;
  try {
    command = parseCommand(event.comment?.body);
  } catch (error) {
    return { reason: 'invalid-command', error };
  }
  if (!command) return { reason: 'not-a-command' };
  return { reason: 'approved', request: { ...command, repo: event.repository.full_name, number: event.issue.number, requester: author.login } };
}

export function requestFromEvent(event, approved) {
  const decision = eventDecision(event, approved);
  if (decision.error) throw decision.error;
  return decision.request ?? null;
}
