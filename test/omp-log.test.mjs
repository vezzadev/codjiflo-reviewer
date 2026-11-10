import test from 'node:test';
import assert from 'node:assert/strict';
import { ompLogFormatter } from '../src/omp-log.mjs';

function render(events, chunkSize = Infinity) {
  let output = '';
  const formatter = ompLogFormatter(text => { output += text; });
  const stream = events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n';
  for (let index = 0; index < stream.length; index += chunkSize) formatter.write(stream.slice(index, index + chunkSize));
  formatter.end();
  return output;
}

const session = [
  { type: 'agent_start' },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'DELTA-NOISE' } },
  { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'PROMPT-ECHO' }] } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Check the diff.', thinkingSignature: 'SIGNATURE-NOISE' }, { type: 'text', text: 'Looking\nnow.' }] } },
  { type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1', intent: 'Listing files', args: { command: 'ls -la' } },
  { type: 'tool_execution_update', toolName: 'bash', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'PARTIAL-NOISE' }] } },
  { type: 'tool_execution_end', toolName: 'bash', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'a.js\nb.js\n' }] } },
  { type: 'tool_execution_start', toolName: 'final_review', toolCallId: 't2', args: { verdict: 'REQUEST_CHANGES', summary: 'One defect.', findings: [{ path: 'a.js', line: 3, priority: 'P1', disposition: 'blocking', title: 'Off by one' }], resolutions: [] } },
  { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', usage: { input: 5, output: 7, cacheRead: 11, cacheWrite: 13, cost: { total: 0.125 } } }] },
];

test('OMP events render as a transcript without deltas, echoes or signatures', () => {
  assert.equal(render(session), [
    '── OMP agent started',
    'thinking:',
    '  │ Check the diff.',
    'assistant:',
    '  │ Looking',
    '  │ now.',
    '▶ bash — Listing files',
    '  $ ls -la',
    '  ✓ bash',
    '  │ a.js',
    '  │ b.js',
    '▶ final_review REQUEST_CHANGES (1 findings)',
    '  │ One defect.',
    '  │ P1 blocking a.js:3 Off by one',
    '── OMP agent finished: 1 assistant messages, stop=stop, tokens in=5 out=7 cacheRead=11 cacheWrite=13, cost=$0.13',
    '',
  ].join('\n'));
});

test('rendering does not depend on stream chunk boundaries', () => {
  assert.equal(render(session, 7), render(session));
});

test('model and tool content cannot start a log line with a workflow command', () => {
  const output = render([
    '::add-mask::raw',
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '::error::text\n::stop-commands::x' }], stopReason: 'error', errorMessage: '::warning::diagnostic' } },
    { type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1', args: { command: 'true\n::set-output name=a::b' } },
    { type: 'tool_execution_end', toolName: 'bash', toolCallId: 't1', isError: true, result: { content: [{ type: 'text', text: '::group::tool' }] } },
    { type: 'tool_execution_start', toolName: 'final_review', toolCallId: 't2', args: { verdict: 'APPROVE', summary: '::notice::summary', findings: [] } },
  ]);
  assert.equal(output.split('\n').filter(line => line.trimStart().startsWith('::')).length, 0);
  assert.match(output, /✗ failed bash/);
});

test('long tool output is truncated with the omitted amount', () => {
  const text = Array.from({ length: 45 }, (_, index) => `line ${index}`).join('\n') + '\n' + 'x'.repeat(450);
  const output = render([{ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text }] } }]);
  assert.match(output, /line 39\n {2}│ … \(\+6 lines\)\n$/);
  const long = render([{ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'x'.repeat(450) }] } }]);
  assert.match(long, /x{400}… \(\+50 chars\)\n$/);
});
