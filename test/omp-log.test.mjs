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
    '::add-mask::raw ##[add-mask]raw',
    { type: 'notice', level: 'error', message: 'x ##[error]notice' },
    { type: 'tool_execution_end', toolName: 'read', toolCallId: 't0', isError: false, result: { content: [{ type: 'text', text: 'x ##[warning]injected' }] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '::error::text\n::stop-commands::x\rok\r::add-mask::cr\u2028::add-mask::ls' }], stopReason: 'error\n::error::stop', errorMessage: '::warning::diagnostic' } },
    { type: 'tool_execution_start', toolName: 'bash\n::add-mask::name', toolCallId: 't1', intent: 'Reading\n::add-mask::intent\r::add-mask::cr', args: { command: 'true\n::set-output name=a::b' } },
    { type: 'tool_execution_end', toolName: 'bash\r::add-mask::name', toolCallId: 't1', isError: true, result: { content: [{ type: 'text', text: 'ok\r::group::tool' }] } },
    { type: 'tool_execution_start', toolName: 'final_review', toolCallId: 't2', args: { verdict: '\n::error::verdict', summary: '::notice::summary', findings: [
      { priority: '\n::error::priority', disposition: '\r::error::disposition', path: '\n::notice::path', line: '\n::notice::line', title: '\n::warning::title' },
    ] } },
    { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop\n::error::terminal' }] },
  ]);
  assert.equal(output.split(/[\r\n\u0085\u2028\u2029]/).filter(line => line.trimStart().startsWith('::')).length, 0);
  assert.equal(output.includes('##['), false);
  assert.match(output, /✗ failed bash/);
});

test('secrets are redacted before clipping or JSON escaping can split or disguise them', () => {
  const secret = 'sec"ret\\value';
  let output = '';
  const formatter = ompLogFormatter(text => { output += text; }, [secret]);
  for (const event of [
    { type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'x'.repeat(395) + secret }] } },
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 't2', intent: 'i'.repeat(115) + secret, args: { path: secret } },
  ]) formatter.write(JSON.stringify(event) + '\n');
  formatter.write(`not json ${secret}\n`);
  formatter.end();
  for (const fragment of ['sec"', 'sec\\"', 'ret', 'value']) assert.equal(output.includes(fragment), false, fragment);
  assert.match(output, /"path":"\[REDACTED\]"/);
  assert.match(output, /not json \[REDACTED\]/);
});

test('a secret spanning raw output lines is redacted', () => {
  let output = '';
  const formatter = ompLogFormatter(text => { output += text; }, ['BEGIN\nKEY\nEND']);
  formatter.write('before BEGIN\nKEY\nEND after\n{"type":"agent_start"}\n');
  formatter.end();
  assert.equal(output, '  │ before [REDACTED] after\n── OMP agent started\n');
});

test('a secret containing a blank line is redacted across raw output lines', () => {
  let output = '';
  const formatter = ompLogFormatter(text => { output += text; }, ['A1\n\nB2']);
  formatter.write('\nx A1\n\nB2 y\n\n{"type":"agent_start"}\n');
  formatter.end();
  assert.equal(output, '  │ x [REDACTED] y\n── OMP agent started\n');
});

test('a secret spanning many raw lines is redacted while earlier raw output streams', () => {
  const secret = Array.from({ length: 300 }, (_, index) => `key line ${index}`).join('\n');
  let output = '';
  const formatter = ompLogFormatter(text => { output += text; }, [secret]);
  formatter.write(`${'diagnostic\n'.repeat(400)}`);
  assert.match(output, /^( {2}│ diagnostic\n){10,}/);
  formatter.write(`${secret}\n`);
  formatter.end();
  assert.equal(output.includes('key line'), false);
  assert.match(output, /\[REDACTED\]\n$/);
});

test('retries, notices and unknown events stay visible', () => {
  const output = render([
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'overloaded_error 529' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'DELTA-NOISE' } },
  ]);
  assert.equal(output, '· auto_retry_start {"attempt":1,"maxAttempts":3,"errorMessage":"overloaded_error 529"}\n');
});

test('an event the renderer cannot handle neither throws nor corrupts the next line', () => {
  const nested = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000);
  let output = '';
  const formatter = ompLogFormatter(text => { output += text; }, ['p"w']);
  formatter.write(`{"type":"tool_execution_start","toolName":"read","intent":"k p\\"w","args":${nested}}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":5},{"type":"text","text":"second"}]}}\n`);
  formatter.end();
  assert.match(output, /^· tool_execution_start event could not be rendered \(RangeError\)\n/);
  assert.equal(output.includes('p\\"w'), false);
  assert.match(output, /thinking:\n {2}│ 5\nassistant:\n {2}│ second\n$/);
});

test('long tool output is truncated with the omitted amount', () => {
  const text = Array.from({ length: 45 }, (_, index) => `line ${index}`).join('\n') + '\n' + 'x'.repeat(450);
  const output = render([{ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text }] } }]);
  assert.match(output, /line 39\n {2}│ … \(\+6 lines\)\n$/);
  const long = render([{ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'x'.repeat(450) }] } }]);
  assert.match(long, /x{400}… \(\+50 chars\)\n$/);
});
