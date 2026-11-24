import test from 'node:test';
import assert from 'node:assert/strict';
import { agyLogFormatter } from '../src/agy-log.mjs';

function render(events, chunkSize = Infinity) {
  let output = '';
  const formatter = agyLogFormatter(text => { output += text; });
  const stream = events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n';
  for (let index = 0; index < stream.length; index += chunkSize) formatter.write(stream.slice(index, index + chunkSize));
  formatter.end();
  return output;
}

const session = [
  { event: 'init', conversation_id: 'c1', init: { model: 'gemini-4-neon-high', cwd: '/repo', tools: ['read_file', 'run_command'] } },
  { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Looking' } },
  { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\nnow.' } },
  { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } } } },
  { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' }, output: 'a.js\nb.js\n' } } },
  { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'a.js' }, output: '1 lines' } } },
  { event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'finish' } },
  { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', num_turns: 1, structured_output: { verdict: 'REQUEST_CHANGES', summary: 'One defect.', findings: [{ path: 'a.js', line: 3, priority: 'P1', disposition: 'blocking', title: 'Off by one' }], resolutions: [] }, usage: { input_tokens: 5, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 11 } } },
];

test('AGY events render as a transcript merging deltas and omitting prompt echo', () => {
  assert.equal(render(session), [
    '── AGY agent started (gemini-4-neon-high)',
    'assistant:',
    '  │ Looking',
    '  │ now.',
    '▶ run_command',
    '  $ ls -la',
    '  ✓ run_command',
    '  │ a.js',
    '  │ b.js',
    '▶ read_file',
    '  │ {"Path":"a.js"}',
    '  ✓ read_file',
    '  │ 1 lines',
    '▶ structured_output REQUEST_CHANGES (1 findings)',
    '  │ One defect.',
    '  │ P1 blocking a.js:3 Off by one',
    '── AGY agent finished: status=SUCCESS, turns=1, tokens in=5 out=7 thinking=3 cacheRead=11',
    '',
  ].join('\n'));
});

test('rendering does not depend on stream chunk boundaries', () => {
  assert.equal(render(session, 7), render(session));
});

test('model and tool content cannot start a log line with a workflow command', () => {
  const output = render([
    '::add-mask::raw ##[add-mask]raw',
    { event: 'init', init: { model: 'm\n::error::model' } },
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '::error::text\n::stop-commands::x\rok\r::add-mask::cr\u2028::add-mask::ls' } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command\n::add-mask::name', tool_info: { parameters: { CommandLine: 'true\n::set-output name=a::b' }, error: { type: 'denied', message: 'ok\r::group::tool ##[warning]injected' } } } },
    { event: 'result', result: { status: 'ERROR\n::error::status', error: '::warning::diagnostic', structured_output: { verdict: '\n::error::v', summary: '::notice::s', findings: [{ priority: '\n::error::p', disposition: '\r::error::d', path: '\n::notice::path', line: '\n::notice::line', title: '\n::warning::title' }] } } },
  ]);
  assert.equal(output.split(/[\r\n\u0085\u2028\u2029]/).filter(line => line.trimStart().startsWith('::')).length, 0);
  assert.equal(output.includes('##['), false);
  assert.match(output, /✗ failed run_command/);
});

test('secrets are redacted before clipping or JSON escaping can split or disguise them', () => {
  const secret = 'sec"ret\\value';
  let output = '';
  const formatter = agyLogFormatter(text => { output += text; }, [secret]);
  for (const event of [
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: secret }, output: 'x'.repeat(395) + secret } } },
  ]) formatter.write(JSON.stringify(event) + '\n');
  formatter.write(`not json ${secret}\n`);
  formatter.end();
  for (const fragment of ['sec"', 'sec\\"', 'ret', 'value']) assert.equal(output.includes(fragment), false, fragment);
  assert.match(output, /"Path":"\[REDACTED\]"/);
  assert.match(output, /not json \[REDACTED\]/);
});

test('a secret spanning raw output lines is redacted', () => {
  let output = '';
  const formatter = agyLogFormatter(text => { output += text; }, ['BEGIN\nKEY\nEND']);
  formatter.write('before BEGIN\nKEY\nEND after\n{"event":"init","init":{"model":"gemini-4-neon-high"}}\n');
  formatter.end();
  assert.equal(output, '  │ before [REDACTED] after\n── AGY agent started (gemini-4-neon-high)\n');
});

test('an event the renderer cannot handle neither throws nor corrupts the next line', () => {
  const nested = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000);
  let output = '';
  const formatter = agyLogFormatter(text => { output += text; }, ['p"w']);
  formatter.write(`{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"parameters":${nested}}}}\n{"event":"init","init":{"model":"gemini-4-neon-high"}}\n`);
  formatter.end();
  assert.match(output, /^· step_update event could not be rendered \(RangeError\)\n/);
  assert.equal(output.includes('p\\"w'), false);
  assert.match(output, /── AGY agent started \(gemini-4-neon-high\)\n$/);
});

test('long tool output is truncated with the omitted amount', () => {
  const text = Array.from({ length: 45 }, (_, index) => `line ${index}`).join('\n') + '\n' + 'x'.repeat(450);
  const output = render([{ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: {}, output: text } } }]);
  assert.match(output, /line 39\n {2}│ … \(\+6 lines\)\n$/);
  const long = render([{ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: {}, output: 'x'.repeat(450) } } }]);
  assert.match(long, /x{400}… \(\+50 chars\)\n$/);
});
