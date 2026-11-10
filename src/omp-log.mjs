// Renders OMP's `--mode json` event stream as a readable transcript for the
// process log. The raw stream stays the protocol input of parseOmpReview.
//
// GitHub Actions treats a log line that starts with `::`, or that contains
// `##[` anywhere, as a workflow command. Every line carrying model or tool
// content therefore gets a prefix and has `##[` broken up. The runner also
// ends a line at a bare CR, so every line terminator is split.
const MAX_RESULT_LINES = 40;
const MAX_LINE = 400;
const MAX_ARGS = 600;
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;
// Streaming deltas, partial results, turn markers and message starts repeat
// what the rendered events carry. Any other event type is shown as JSON.
const REPEATED = new Set(['session', 'turn_start', 'turn_end', 'message_start', 'message_end', 'message_update', 'tool_execution_update']);

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} chars)` : text;

function quote(text, limit = Infinity) {
  const lines = String(text).trimEnd().split(LINE_BREAK);
  const shown = lines.slice(0, limit).map(line => `  │ ${clip(line, MAX_LINE)}`);
  if (lines.length > limit) shown.push(`  │ … (+${lines.length - limit} lines)`);
  return shown;
}

function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]));
}

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
function eventLines(event, redact) {
  const show = value => typeof value === 'string' ? redact(value) : value === undefined ? '' : redact(String(JSON.stringify(value)));
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
  return event && typeof event === 'object' && typeof event.type === 'string' ? event : undefined;
}

// Fields placed on a header line may carry line terminators of their own.
const guard = lines => lines.flatMap(rendered => rendered.replaceAll('##[', '##\u200b[').split(LINE_BREAK).map((part, index) => index ? `  │ ${part}` : part));

// Stream chunks need not align with event lines, and one event can span many
// chunks: join the parts of a line only once it is complete.
export function ompLogFormatter(write, redact = text => text, { rawIdleMs = 1000, maxRawLines = 200 } = {}) {
  let parts = [];
  // Consecutive lines that are not events are redacted together: a secret
  // may span lines. They are held only briefly, so a diagnostic printed
  // before a stall still reaches the log.
  let raw = [];
  let idle;
  const print = lines => { for (const rendered of guard(lines)) write(`${rendered}\n`); };
  const flushRaw = () => {
    clearTimeout(idle);
    if (raw.some(line => line.trim())) print(quote(redact(raw.join('\n'))));
    raw = [];
  };
  const hold = line => {
    raw.push(line);
    clearTimeout(idle);
    if (raw.length >= maxRawLines) { flushRaw(); return; }
    idle = setTimeout(flushRaw, rawIdleMs);
    idle.unref();
  };
  const emit = line => {
    const event = line.trim() ? parse(line) : undefined;
    // A blank line may be part of a secret spanning raw lines.
    if (!event) { if (line.trim() || raw.length) hold(line); return; }
    flushRaw();
    // Rendering must not fail the review: the protocol is validated
    // elsewhere. The fallback carries no event content, which would be
    // JSON-escaped and so beyond redaction.
    let lines;
    try { lines = eventLines(event, redact); } catch (error) { lines = [`· event could not be rendered (${error?.name})`]; }
    print(lines);
  };
  const take = () => { const line = parts.join(''); parts = []; return line; };
  return {
    write(chunk) {
      let start = 0;
      for (let end = chunk.indexOf('\n'); end >= 0; end = chunk.indexOf('\n', start)) {
        parts.push(chunk.slice(start, end));
        emit(take());
        start = end + 1;
      }
      if (start < chunk.length) parts.push(chunk.slice(start));
    },
    end() { emit(take()); flushRaw(); },
  };
}
