// Renders OMP's `--mode json` event stream as a readable transcript for the
// process log. The raw stream stays the protocol input of parseOmpReview.
//
// Every line carrying model or tool content gets a prefix: GitHub Actions
// treats a log line that starts with `::` as a workflow command. The runner
// also ends a line at a bare CR, so every line terminator is split.
const MAX_RESULT_LINES = 40;
const MAX_LINE = 400;
const MAX_ARGS = 600;
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} chars)` : text;

function quote(text, limit = Infinity) {
  const lines = String(text).replace(/\s+$/, '').split(LINE_BREAK);
  const shown = lines.slice(0, limit).map(line => `  │ ${clip(line, MAX_LINE)}`);
  if (lines.length > limit) shown.push(`  │ … (+${lines.length - limit} lines)`);
  return shown;
}

// Redact whole values before any clipping or JSON escaping can split or
// disguise a secret.
function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]));
}

const textOf = content => (Array.isArray(content) ? content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');

function assistantLines(message) {
  const lines = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part?.type === 'thinking' && part.thinking?.trim()) lines.push('thinking:', ...quote(part.thinking));
    if (part?.type === 'text' && part.text?.trim()) lines.push('assistant:', ...quote(part.text));
  }
  if (typeof message.errorMessage === 'string') lines.push(`assistant error (${message.stopReason}):`, ...quote(message.errorMessage));
  return lines;
}

function toolStartLines(event) {
  const args = event.args ?? {};
  const title = `▶ ${event.toolName}${typeof event.intent === 'string' ? ` — ${clip(event.intent, 120)}` : ''}`;
  if (event.toolName === 'final_review') {
    const findings = Array.isArray(args.findings) ? args.findings : [];
    return [`${title} ${args.verdict} (${findings.length} findings)`, ...quote(args.summary ?? ''),
      ...findings.map(finding => `  │ ${finding?.priority} ${finding?.disposition} ${finding?.path}:${finding?.line} ${clip(String(finding?.title), MAX_LINE)}`)];
  }
  if (typeof args.command === 'string') return [title, ...quote(args.command).map(line => line.replace('│', '$'))];
  return [title, `  │ ${clip(JSON.stringify(args), MAX_ARGS)}`];
}

function toolEndLines(event) {
  const status = event.isError ? '✗ failed' : '✓';
  const output = textOf(event.result?.content);
  return [`  ${status} ${event.toolName}`, ...(output.trim() ? quote(output, MAX_RESULT_LINES) : [])];
}

function finishLines(event) {
  const assistants = (Array.isArray(event.messages) ? event.messages : []).filter(message => message?.role === 'assistant');
  const sum = key => assistants.reduce((total, message) => total + (Number(message.usage?.[key]) || 0), 0);
  const cost = assistants.reduce((total, message) => total + (Number(message.usage?.cost?.total) || 0), 0);
  return [`── OMP agent finished: ${assistants.length} assistant messages, stop=${assistants.at(-1)?.stopReason}, tokens in=${sum('input')} out=${sum('output')} cacheRead=${sum('cacheRead')} cacheWrite=${sum('cacheWrite')}, cost=$${cost.toFixed(2)}`];
}

function eventLines(event, redact) {
  if (event.type === 'agent_start') return ['── OMP agent started'];
  if (event.type === 'agent_end') return finishLines(event);
  if (event.type === 'message_end' && event.message?.role === 'assistant') return assistantLines(redactDeep(event.message, redact));
  if (event.type === 'tool_execution_start') return toolStartLines(redactDeep(event, redact));
  if (event.type === 'tool_execution_end') return toolEndLines(redactDeep(event, redact));
  // Deltas, partial tool results, turn markers and echoed user/tool messages
  // repeat what the events above already carry.
  return [];
}

function render(line, redact) {
  if (!line.trim()) return [];
  let event;
  try { event = JSON.parse(line); } catch { return quote(redact(line)); }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return quote(redact(line));
  // Fields placed on a header line may carry line terminators of their own.
  return eventLines(event, redact).flatMap(rendered => rendered.split(LINE_BREAK).map((part, index) => index ? `  │ ${part}` : part));
}

// Stream chunks need not align with event lines, and one event can span many
// chunks: join the parts of a line only once it is complete.
export function ompLogFormatter(write, redact = text => text) {
  let parts = [];
  const emit = line => { for (const rendered of render(line, redact)) write(`${rendered}\n`); };
  return {
    write(chunk) {
      let start = 0;
      for (let end = chunk.indexOf('\n'); end >= 0; end = chunk.indexOf('\n', start)) {
        parts.push(chunk.slice(start, end));
        emit(parts.join(''));
        parts = [];
        start = end + 1;
      }
      if (start < chunk.length) parts.push(chunk.slice(start));
    },
    end() { emit(parts.join('')); parts = []; },
  };
}
