import { secretRedactor } from './redaction.mjs';

// Renders Antigravity CLI's `--output-format stream-json` NDJSON event stream
// as a readable transcript for the process log. The raw stream stays the
// protocol input of parseAgyReview.
//
// GitHub Actions treats a log line that starts with `::`, or that contains
// `##[` anywhere, as a workflow command. Every line carrying model or tool
// content therefore gets a prefix and has `##[` broken up. The runner also
// ends a line at a bare CR, so every line terminator is split.
const MAX_RESULT_LINES = 40;
const MAX_LINE = 400;
const MAX_ARGS = 600;
const MAX_STEP_TEXT = 65536;
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;
const IGNORED_STEP_TYPES = new Set(['user_input', 'checkpoint', 'finish']);

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

function toolStartLines(step, show, redact) {
  const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
  const name = step.tool_name ?? info.name ?? 'tool';
  const params = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
  const title = `▶ ${show(name)}`;
  const command = typeof params.CommandLine === 'string' ? params.CommandLine : typeof params.command === 'string' ? params.command : undefined;
  if (command !== undefined) return [title, ...quote(show(command)).map(line => line.replace('│', '$'))];
  return [title, `  │ ${clip(JSON.stringify(redactDeep(params, redact)), MAX_ARGS)}`];
}

function toolEndLines(step, show) {
  const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
  const name = step.tool_name ?? info.name ?? 'tool';
  const hasError = Boolean(info.error);
  const rawOutput = hasError
    ? (typeof info.error?.message === 'string' ? info.error.message : JSON.stringify(info.error))
    : (typeof info.output === 'string' ? info.output : '');
  const output = rawOutput ? show(rawOutput) : '';
  return [`  ${hasError ? '✗ failed' : '✓'} ${show(name)}`, ...(output.trim() ? quote(output, MAX_RESULT_LINES) : [])];
}

function resultLines(result, show) {
  const lines = [];
  const structured = result.structured_output;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const findings = Array.isArray(structured.findings) ? structured.findings : [];
    lines.push(
      `▶ structured_output ${show(structured.verdict)} (${findings.length} findings)`,
      ...quote(show(structured.summary)),
      ...findings.map(finding => `  │ ${show(finding?.priority)} ${show(finding?.disposition)} ${show(finding?.path)}:${show(finding?.line)} ${clip(show(finding?.title), MAX_LINE)}`),
    );
  }
  if (typeof result.error === 'string' && result.error.trim()) {
    lines.push(`agent error (${show(result.status)}):`, ...quote(show(result.error)));
  }
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : {};
  const num = key => Number(usage[key]) || 0;
  lines.push(`── AGY agent finished: status=${show(result.status)}, turns=${Number(result.num_turns) || 0}, tokens in=${num('input_tokens')} out=${num('output_tokens')} thinking=${num('thinking_tokens')} cacheRead=${num('cache_read_tokens')}`);
  return lines;
}

function parse(line) {
  let event;
  try { event = JSON.parse(line); } catch { return undefined; }
  return event && typeof event === 'object' && !Array.isArray(event) && typeof event.event === 'string' ? event : undefined;
}

const guard = lines => lines.flatMap(rendered => rendered.replaceAll('##[', '##\u200b[').split(LINE_BREAK).map((part, index) => index ? `  │ ${part}` : part));

export function agyLogFormatter(write, secrets = []) {
  let parts = [];
  const stepText = new Map();
  const startedTools = new Set();
  const print = lines => { for (const rendered of guard(lines)) write(`${rendered}\n`); };
  let rawText = '';
  const printRaw = lines => print(lines.filter(line => line.trim()).flatMap(line => quote(line)));
  const raw = secretRedactor(secrets, text => {
    const lines = (rawText + text).split('\n');
    rawText = lines.pop();
    printRaw(lines);
  });
  const { redact } = raw;
  let rawOpen = false;
  const closeRaw = () => {
    raw.end();
    printRaw([rawText]);
    rawText = '';
    rawOpen = false;
  };
  const show = value => typeof value === 'string' ? redact(value) : value === undefined ? '' : redact(String(JSON.stringify(value)));
  const stepLines = step => {
    if (!step || typeof step !== 'object' || IGNORED_STEP_TYPES.has(step.step_type)) return [];
    const index = step.step_index;
    if (step.step_type === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      const existing = stepText.get(index) ?? '';
      const combined = existing.length < MAX_STEP_TEXT ? existing + delta.slice(0, MAX_STEP_TEXT - existing.length) : existing;
      if (step.state !== 'DONE') {
        if (delta) stepText.set(index, combined);
        return [];
      }
      stepText.delete(index);
      const rendered = show(combined);
      return rendered.trim() ? ['assistant:', ...quote(rendered)] : [];
    }
    if (step.step_type === 'tool') {
      if (step.state === 'ACTIVE') {
        startedTools.add(index);
        return toolStartLines(step, show, redact);
      }
      if (step.state === 'DONE') {
        const lines = startedTools.has(index) ? [] : toolStartLines(step, show, redact);
        startedTools.delete(index);
        return [...lines, ...toolEndLines(step, show)];
      }
      return [];
    }
    const { step_type: type, ...detail } = step;
    return [`· step:${show(type)} ${clip(JSON.stringify(redactDeep(detail, redact)), MAX_ARGS)}`];
  };
  const eventLines = event => {
    if (event.event === 'init') {
      const model = event.init?.model;
      return [`── AGY agent started${typeof model === 'string' && model ? ` (${show(model)})` : ''}`];
    }
    if (event.event === 'step_update') return stepLines(event.step_update);
    if (event.event === 'result') return resultLines(event.result && typeof event.result === 'object' ? event.result : {}, show);
    const { event: type, ...detail } = event;
    return [`· ${show(type)} ${clip(JSON.stringify(redactDeep(detail, redact)), MAX_ARGS)}`];
  };
  const emit = line => {
    const event = line.trim() ? parse(line) : undefined;
    if (!event && (line.trim() || rawOpen)) { rawOpen = true; raw.write(`${line}\n`); }
    if (!event) return;
    closeRaw();
    let lines;
    try { lines = eventLines(event); } catch (error) { lines = [`· ${clip(redact(event.event), 80)} event could not be rendered (${error instanceof Error ? error.name : 'error'})`]; }
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
    end() { emit(take()); closeRaw(); },
  };
}
