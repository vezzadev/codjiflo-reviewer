import { MAX_ARGS, MAX_LINE, MAX_RESULT_LINES, clip, ndjsonLogFormatter, quote, redactDeep } from './log-format.mjs';

// Renders OMP's `--mode json` event stream as a readable transcript for the
// process log. The raw stream stays the protocol input of parseOmpReview.
// Streaming deltas, partial results, turn markers and message starts repeat
// what the rendered events carry. Any other event type is shown as JSON.
const REPEATED = new Set(['session', 'turn_start', 'turn_end', 'message_start', 'message_end', 'message_update', 'tool_execution_update']);

function assistantLines(message, show) {
  const lines = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    const content = part?.type === 'thinking' ? show(part.thinking) : part?.type === 'text' ? show(part.text) : '';
    if (content.trim()) lines.push(part.type === 'thinking' ? 'thinking:' : 'assistant:', ...quote(content));
  }
  if (typeof message.errorMessage === 'string') lines.push(`assistant error (${show(message.stopReason)}):`, ...quote(show(message.errorMessage)));
  return lines;
}

function toolStartLines(event, show, redact) {
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  const title = `▶ ${show(event.toolName)}${typeof event.intent === 'string' ? ` — ${clip(show(event.intent), 120)}` : ''}`;
  if (event.toolName === 'final_review') {
    const findings = Array.isArray(args.findings) ? args.findings : [];
    return [`${title} ${show(args.verdict)} (${findings.length} findings)`, ...quote(show(args.summary)),
      ...findings.map(finding => `  │ ${show(finding?.priority)} ${show(finding?.disposition)} ${show(finding?.path)}:${show(finding?.line)} ${clip(show(finding?.title), MAX_LINE)}`)];
  }
  if (typeof args.command === 'string') return [title, ...quote(show(args.command)).map(line => line.replace('│', '$'))];
  return [title, `  │ ${clip(JSON.stringify(redactDeep(args, redact)), MAX_ARGS)}`];
}

function toolEndLines(event, show) {
  const content = Array.isArray(event.result?.content) ? event.result.content : [];
  const output = show(content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'));
  return [`  ${event.isError ? '✗ failed' : '✓'} ${show(event.toolName)}`, ...(output.trim() ? quote(output, MAX_RESULT_LINES) : [])];
}

function finishLines(event, show) {
  const assistants = (Array.isArray(event.messages) ? event.messages : []).filter(message => message?.role === 'assistant');
  const sum = key => assistants.reduce((total, message) => total + (Number(message.usage?.[key]) || 0), 0);
  const cost = assistants.reduce((total, message) => total + (Number(message.usage?.cost?.total) || 0), 0);
  return [`── OMP agent finished: ${assistants.length} assistant messages, stop=${show(assistants.at(-1)?.stopReason)}, tokens in=${sum('input')} out=${sum('output')} cacheRead=${sum('cacheRead')} cacheWrite=${sum('cacheWrite')}, cost=$${cost.toFixed(2)}`];
}

// Each rendered value is redacted whole, before clipping or JSON escaping can
// split or disguise a secret.
function eventLines(event, { show, redact }) {
  if (event.type === 'agent_start') return ['── OMP agent started'];
  if (event.type === 'agent_end') return finishLines(event, show);
  if (event.type === 'message_end' && event.message?.role === 'assistant') return assistantLines(event.message, show);
  if (event.type === 'tool_execution_start') return toolStartLines(event, show, redact);
  if (event.type === 'tool_execution_end') return toolEndLines(event, show);
  if (REPEATED.has(event.type)) return [];
  // Retries, notices, compaction and anything OMP adds later.
  const { type, ...detail } = event;
  return [`· ${show(type)} ${clip(JSON.stringify(redactDeep(detail, redact)), MAX_ARGS)}`];
}

function parse(line) {
  let event;
  try { event = JSON.parse(line); } catch { return undefined; }
  return event && typeof event === 'object' && !Array.isArray(event) && typeof event.type === 'string' ? event : undefined;
}

export function ompLogFormatter(write, secrets = []) {
  return ndjsonLogFormatter(write, secrets, { parse, eventType: event => event.type, render: eventLines });
}
