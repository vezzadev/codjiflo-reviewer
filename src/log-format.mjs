import { secretRedactor } from './redaction.mjs';

// Shared framing, redaction and GitHub Actions workflow-command escaping for
// reviewer NDJSON transcript formatters (OMP and Antigravity CLI).
//
// GitHub Actions treats a log line that starts with `::`, or that contains
// `##[` anywhere, as a workflow command. Every line carrying model or tool
// content therefore gets a prefix and has `##[` broken up. The runner also
// ends a line at a bare CR, so every line terminator is split.
export const MAX_RESULT_LINES = 40;
export const MAX_LINE = 400;
export const MAX_ARGS = 600;
export const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;

export const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} chars)` : text;

export function quote(text, limit = Infinity) {
  const lines = String(text).trimEnd().split(LINE_BREAK);
  const shown = lines.slice(0, limit).map(line => `  │ ${clip(line, MAX_LINE)}`);
  if (lines.length > limit) shown.push(`  │ … (+${lines.length - limit} lines)`);
  return shown;
}

export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactDeep(item, redact)]));
}

// Fields placed on a header line may carry line terminators of their own.
const guard = lines => lines.flatMap(rendered => rendered.replaceAll('##[', '##\u200b[').split(LINE_BREAK).map((part, index) => index ? `  │ ${part}` : part));

function parseEvent(line, typeKey) {
  let event;
  try { event = JSON.parse(line); } catch { return undefined; }
  return event && typeof event === 'object' && !Array.isArray(event) && typeof event[typeKey] === 'string' ? event : undefined;
}

// Stream chunks need not align with event lines, and one event can span many
// chunks: join the parts of a line only once it is complete.
export function ndjsonLogFormatter(write, secrets = [], { typeKey, render, onEnd }) {
  let parts = [];
  const print = lines => { for (const rendered of guard(lines)) write(`${rendered}\n`); };
  // Lines that are not events go through a stream redactor before they are
  // split and prefixed: a secret may span lines. It holds back at most the
  // longest secret's length, and is drained at the next event.
  let rawText = '';
  const printRaw = lines => print(lines.filter(line => line.trim()).flatMap(line => quote(line)));
  const raw = secretRedactor(secrets, text => {
    const lines = (rawText + text).split('\n');
    rawText = lines.pop();
    printRaw(lines);
  });
  const { redact } = raw;
  const show = value => typeof value === 'string'
    ? redact(value)
    : value === undefined ? '' : redact(String(JSON.stringify(redactDeep(value, redact))));
  let rawOpen = false;
  const closeRaw = () => {
    raw.end();
    printRaw([rawText]);
    rawText = '';
    rawOpen = false;
  };
  const emit = line => {
    const event = line.trim() ? parseEvent(line, typeKey) : undefined;
    // A blank line may be part of a secret spanning raw lines.
    if (!event && (line.trim() || rawOpen)) { rawOpen = true; raw.write(`${line}\n`); }
    if (!event) return;
    closeRaw();
    // Rendering must not fail the review: the protocol is validated
    // elsewhere. The fallback carries no event content, which would be
    // JSON-escaped and so beyond redaction.
    let lines;
    try { lines = render(event, { show, redact }); }
    catch (error) { lines = [`· ${clip(redact(event[typeKey]), 80)} event could not be rendered (${error instanceof Error ? error.name : 'error'})`]; }
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
    end() {
      emit(take());
      closeRaw();
      if (onEnd) {
        let lines;
        try { lines = onEnd({ show, redact }); } catch { lines = []; }
        if (lines?.length) print(lines);
      }
    },
  };
}
