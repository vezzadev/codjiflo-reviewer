import { secretRedactor } from './redaction.mjs';
import { MAX_ARGS, MAX_LINE, MAX_RESULT_LINES, clip, ndjsonLogFormatter, quote, redactDeep } from './log-format.mjs';

// Renders Antigravity CLI's `--output-format stream-json` NDJSON event stream
// as a readable transcript for the process log. The raw stream stays the
// protocol input of parseAgyReview.
const MAX_STEP_TEXT = 65536;
const IGNORED_STEP_TYPES = new Set(['user_input', 'checkpoint', 'finish']);
const TERMINAL_STATES = new Set(['DONE', 'ERROR', 'CANCELED', 'CANCELLED', 'FAILED', 'INTERRUPTED']);
const UNINDEXED = Symbol('unindexed');

function toolStartLines(step, show, redact) {
  const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
  const name = step.tool_name ?? info.name ?? 'tool';
  const params = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
  const title = `▶ ${show(name)}`;
  const command = typeof params.CommandLine === 'string' ? params.CommandLine : typeof params.command === 'string' ? params.command : undefined;
  if (command !== undefined) return [title, ...quote(show(command)).map(line => line.replace('│', '$'))];
  return [title, `  │ ${clip(JSON.stringify(redactDeep(params, redact)), MAX_ARGS)}`];
}

function toolEndLines(step, show, redact) {
  const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
  const name = step.tool_name ?? info.name ?? 'tool';
  const hasError = Boolean(info.error) || (typeof step.state === 'string' && step.state !== 'DONE');
  const output = info.error
    ? (typeof info.error === 'string'
      ? show(info.error)
      : typeof info.error?.message === 'string' && info.error.message.trim()
        ? show(info.error.message)
        : JSON.stringify(redactDeep(info.error, redact)))
    : (typeof info.output === 'string' ? show(info.output) : '');
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

function createStepBuffer(secrets) {
  let text = '';
  let truncated = false;
  const redactor = secretRedactor(secrets, chunk => {
    if (text.length < MAX_STEP_TEXT) {
      const remaining = MAX_STEP_TEXT - text.length;
      text += chunk.slice(0, remaining);
      if (chunk.length > remaining) truncated = true;
    } else if (chunk.length) {
      truncated = true;
    }
  });
  return {
    write(delta) { if (delta && !truncated) redactor.write(delta); },
    flush() {
      if (!truncated) redactor.end();
      const output = truncated ? `${text}… (truncated)` : text;
      text = '';
      truncated = false;
      return output;
    },
  };
}

export function agyLogFormatter(write, secrets = []) {
  const stepBuffers = new Map();
  const startedTools = new Set();
  const flushKey = key => {
    const buffer = stepBuffers.get(key);
    if (!buffer) return [];
    stepBuffers.delete(key);
    const rendered = buffer.flush();
    return rendered.trim() ? ['assistant:', ...quote(rendered)] : [];
  };
  const flushBufferedResponses = () => {
    const lines = [];
    for (const key of [...stepBuffers.keys()]) lines.push(...flushKey(key));
    return lines;
  };
  const stepLines = (step, { show, redact }) => {
    if (!step || typeof step !== 'object' || IGNORED_STEP_TYPES.has(step.step_type)) return [];
    const hasIndex = step.step_index !== undefined && step.step_index !== null;
    const index = step.step_index;
    const state = typeof step.state === 'string' ? step.state : '';
    const terminal = TERMINAL_STATES.has(state);
    if (step.step_type === 'agent_response') {
      const key = hasIndex ? index : UNINDEXED;
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
      let buffer = stepBuffers.get(key);
      if (!buffer && delta) {
        buffer = createStepBuffer(secrets);
        stepBuffers.set(key, buffer);
      }
      if (buffer && delta) buffer.write(delta);
      return terminal ? flushKey(key) : [];
    }
    const prefix = flushKey(UNINDEXED);
    if (step.step_type === 'tool') {
      if (state === 'ACTIVE') {
        if (hasIndex && startedTools.has(index)) return prefix;
        if (hasIndex) startedTools.add(index);
        return [...prefix, ...toolStartLines(step, show, redact)];
      }
      if (terminal) {
        const alreadyStarted = hasIndex && startedTools.has(index);
        if (hasIndex) startedTools.delete(index);
        const lines = alreadyStarted ? [] : toolStartLines(step, show, redact);
        return [...prefix, ...lines, ...toolEndLines(step, show, redact)];
      }
      return prefix;
    }
    const { step_type: type, ...detail } = step;
    return [...prefix, `· step:${show(type)} ${clip(JSON.stringify(redactDeep(detail, redact)), MAX_ARGS)}`];
  };
  const eventLines = (event, helpers) => {
    const { show, redact } = helpers;
    if (event.event === 'init') {
      const model = event.init?.model;
      return [`── AGY agent started${typeof model === 'string' && model ? ` (${show(model)})` : ''}`];
    }
    if (event.event === 'step_update') return stepLines(event.step_update, helpers);
    if (event.event === 'result') {
      return [...flushBufferedResponses(), ...resultLines(event.result && typeof event.result === 'object' ? event.result : {}, show)];
    }
    const { event: type, ...detail } = event;
    return [`· ${show(type)} ${clip(JSON.stringify(redactDeep(detail, redact)), MAX_ARGS)}`];
  };
  return ndjsonLogFormatter(write, secrets, {
    typeKey: 'event',
    render: eventLines,
    onEnd: flushBufferedResponses,
  });
}
