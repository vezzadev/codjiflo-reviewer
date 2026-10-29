import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeReview, classifyClaudeQuota, secretRedactor, claudeEnvironment } from '../src/claude.mjs';
import { runProcess } from '../src/runner.mjs';

const preset = { model: 'claude-opus-4-8', effort: 'xhigh' };
const review = { verdict: 'APPROVE', summary: 'Reviewed.', findings: [] };
const success = { type: 'result', subtype: 'success', is_error: false, structured_output: review };
const failure = { type: 'result', subtype: 'success', is_error: true };
const oauthSuccess = async (_command, args) => JSON.stringify(args[0] === 'auth' ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } : success);
const apiError = (error, text = '') => ({ type: 'assistant', error, message: { content: [{ type: 'text', text }] } });
const spendLimitText = 'API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';
const unknownSpendLimit = { ...apiError('unknown', spendLimitText), is_api_error_message: true, api_error_status: 400 };

async function setup(t, { configured = true, shared = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codjiflo-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keys = Array.from({ length: 3 }, (_, i) => ({ id: `api-${i + 1}`, apiKey: `sk-ant-api03-fixture-secret-${i + 1}`, ...(shared ? { quotaGroup: 'shared-pool' } : {}) }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODJIFLO_ANTHROPIC_KEYS_FILE: join(home, 'keys.json'), CODJIFLO_CLAUDE_STATE_FILE: join(home, 'state.json'), CODJIFLO_OPUS_MODEL: '', CODJIFLO_SOL_MODEL: '' };
  if (configured) await writeFile(env.CODJIFLO_ANTHROPIC_KEYS_FILE, JSON.stringify({ keys }), { mode: 0o600 });
  let log = '';
  const sink = { write: data => { log += data; } };
  const options = { preset, prompt: 'Review fixture.', cwd: home, env, stdout: sink, stderr: sink, runProcess: async () => { throw new Error('Unexpected OAuth fallback'); } };
  return { keys, env, home, options, log: () => log };
}

function sessions(events, captures = []) {
  return request => {
    const capture = { ...request, closed: false };
    captures.push(capture);
    return { async *[Symbol.asyncIterator]() { yield* typeof events === 'function' ? events(request, captures.length) : events; }, close() { capture.closed = true; } };
  };
}

test('SDK succeeds with the selected API key and closes session', async t => {
  const f = await setup(t);
  const captures = [];
  assert.deepEqual(await runClaudeReview({ ...f.options, query: sessions([success], captures) }), review);
  const options = captures[0].options;
  assert.equal(options.env.ANTHROPIC_API_KEY, f.keys[0].apiKey);
  assert.equal(captures[0].closed, true);
});

test('quota failures rotate once per key and OAuth receives only remaining deadline', async t => {
  const f = await setup(t);
  const captures = [];
  let fallback;
  const query = sessions([apiError('rate_limit'), failure], captures);
  const result = await runClaudeReview({ ...f.options, query, timeoutMs: 5000, runProcess: async (command, args, options) => {
    if (args[0] === 'auth') return oauthSuccess(command, args);
    fallback = { command, args, options };
    return JSON.stringify(success);
  } });
  assert.deepEqual(result, review);
  assert.deepEqual(captures.map(value => value.options.env.ANTHROPIC_API_KEY), f.keys.map(key => key.apiKey));
  assert.ok(captures.every(value => value.closed));
  assert.ok(fallback.options.timeoutMs > 0 && fallback.options.timeoutMs < 5000);
  assert.equal(fallback.options.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(fallback.args.includes('--json-schema'));
  assert.ok(fallback.args.includes('--no-session-persistence'));
  // Persistent cooldown is shared by a second review, not just this attempt.
  await runClaudeReview({ ...f.options, query: () => { throw new Error('Unavailable key reused'); }, runProcess: oauthSuccess });
});

test('shared quota group blocks sibling keys without trying them', async t => {
  const f = await setup(t, { shared: true });
  const captures = [];
  await runClaudeReview({ ...f.options, query: sessions([apiError('billing_error', 'Your credit balance is too low to access the Anthropic API.'), failure], captures), runProcess: oauthSuccess });
  assert.equal(captures.length, 1);
});

test('missing configuration uses existing CLI login without importing SDK', async t => {
  const f = await setup(t, { configured: false });
  await runClaudeReview({ ...f.options, query: () => { throw new Error('SDK must not run'); }, runProcess: oauthSuccess });
  assert.match(f.log(), /no API key configuration/);
});

test('invalid present configuration fails before either provider', async t => {
  const f = await setup(t);
  await writeFile(f.env.CODJIFLO_ANTHROPIC_KEYS_FILE, '{');
  await assert.rejects(runClaudeReview({ ...f.options, query: () => { throw new Error('Unexpected SDK'); } }));
  assert.equal(f.log(), '');
});

test('quota classifiers require typed API errors and known exhaustion evidence', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(classifyClaudeQuota(apiError('rate_limit'), now), { status: 'cooldown', retryAt: now + 60_000, reason: 'rate-limit' });
  assert.equal(classifyClaudeQuota(apiError('rate_limit'), now, 1234).retryAt, now + 1234);
  assert.deepEqual(classifyClaudeQuota(apiError('invalid_request', 'You have reached your specified workspace API usage limits. Limits reset on 2026-02-01.'), now), { status: 'exhausted', retryAt: Date.parse('2026-02-01'), reason: 'spend-limit' });
  assert.equal(classifyClaudeQuota(apiError('rate_limit', 'API Error: 429 {"error":{"details":{"error_code":"enforced_spend_limit_reached"}}}'), now).status, 'exhausted');
  assert.deepEqual(classifyClaudeQuota(apiError('billing_error', 'Credit balance is too low'), now), { status: 'exhausted', retryAt: null, reason: 'credit-balance' });
  for (const event of [
    apiError('billing_error', 'Billing system unavailable'),
    apiError('authentication_failed', 'Insufficient credits'),
    apiError('invalid_request', 'Credit balance is too low'),
    apiError('billing_error', 'Credit balance is too low according to an unrelated diagnostic'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Credit balance is too low' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Insufficient credits; rate limit; enforced_spend_limit_reached' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', overageStatus: 'rejected' } },
    { type: 'result', subtype: 'error_max_budget_usd', errors: ['Insufficient credits'] },
  ]) assert.equal(classifyClaudeQuota(event, now), null);
});

test('observed unknown HTTP 400 spend limits exhaust keys until the stated UTC reset, then use OAuth', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-29T12:00:00Z') });
  const f = await setup(t);
  const captures = [];
  const result = await runClaudeReview({ ...f.options, query: sessions([
    unknownSpendLimit, { ...failure, api_error_status: 400, terminal_reason: 'api_error', result: spendLimitText },
  ], captures), runProcess: oauthSuccess });
  assert.deepEqual(result, review);
  assert.equal(captures.length, 3);
  assert.ok(captures.every(capture => capture.closed));
  const state = JSON.parse(await readFile(f.env.CODJIFLO_CLAUDE_STATE_FILE, 'utf8'));
  for (const key of f.keys) {
    assert.equal(state.keys[key.id].status, 'exhausted');
    assert.equal(state.keys[key.id].reason, 'spend-limit');
    assert.equal(state.keys[key.id].retryAt, Date.parse('2026-11-01T00:00:00Z'));
  }
});

test('unknown errors need typed HTTP 400 API evidence and a known spend-limit sentence', async t => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const atTime = { ...unknownSpendLimit, message: { content: [{ type: 'text', text: spendLimitText.replace('00:00', '13:45') }] } };
  assert.equal(classifyClaudeQuota(atTime, now).retryAt, Date.parse('2026-11-01T13:45:00Z'));
  assert.equal(classifyClaudeQuota(unknownSpendLimit, Date.parse('2026-11-02T00:00:00Z')).retryAt, null);
  for (const event of [
    apiError('unknown', spendLimitText),
    { ...unknownSpendLimit, is_api_error_message: false },
    { ...unknownSpendLimit, api_error_status: 401 },
    { ...unknownSpendLimit, message: { content: [{ type: 'text', text: 'API Error: 400 Invalid model' }] } },
    { ...unknownSpendLimit, message: { content: [{ type: 'text', text: `The API documentation says: ${spendLimitText}` }] } },
    { type: 'result', subtype: 'success', is_error: true, result: spendLimitText, api_error_status: 400 },
  ]) {
    assert.equal(classifyClaudeQuota(event, now), null);
    const f = await setup(t);
    const captures = [];
    await assert.rejects(runClaudeReview({ ...f.options, query: sessions([event, failure], captures) }), /is_error=true/);
    assert.equal(captures.length, 1, 'unrecognized failures must not rotate or use OAuth');
  }
});

test('success subtype with is_error remains a failure even with structured output', async t => {
  const f = await setup(t);
  const captures = [];
  await assert.rejects(runClaudeReview({ ...f.options, query: sessions([{ ...success, is_error: true }], captures) }), /subtype=success, is_error=true/);
  assert.equal(captures.length, 1);
  const oauth = await setup(t, { configured: false });
  await assert.rejects(runClaudeReview({ ...oauth.options, runProcess: async (_command, args) => JSON.stringify(args[0] === 'auth'
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }
    : { ...success, is_error: true }) }), /Claude did not complete successfully/);
});

test('non-quota SDK retries and nonterminal assistant errors may recover', async t => {
  const f = await setup(t);
  const captures = [];
  await runClaudeReview({ ...f.options, query: sessions([
    { type: 'system', subtype: 'api_retry', error: 'overloaded', error_status: 529, retry_delay_ms: 7000 },
    apiError('rate_limit'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered' }] } },
    success,
  ], captures) });
  assert.equal(captures.length, 1);
  assert.match(f.log(), /api_retry/);
});

test('documented API 429 retry cools down immediately without waiting for SDK sleep', async t => {
  const f = await setup(t);
  const captures = [];
  await runClaudeReview({ ...f.options, query: sessions((_request, number) => number === 1 ? [
    { type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, retry_delay_ms: 120_000 },
  ] : [success], captures) });
  assert.equal(captures.length, 2);
  assert.ok(captures.every(value => value.closed));
});

test('OAuth guard rejects absent login, API-key helpers and cloud providers without review launch', async t => {
  for (const auth of [
    { loggedIn: false }, { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
  ]) {
    const f = await setup(t, { configured: false });
    let calls = 0;
    await assert.rejects(runClaudeReview({ ...f.options, runProcess: async (_command, args) => {
      calls++;
      assert.deepEqual(args, ['auth', 'status', '--json']);
      return JSON.stringify(auth);
    } }), /requires an existing first-party/);
    assert.equal(calls, 1);
    assert.ok(!f.log().includes(JSON.stringify(auth)));
  }
});

test('keys rotated during a review are refreshed and all new credentials are redacted', async t => {
  const f = await setup(t);
  const rotated = f.keys.map(key => ({ ...key, apiKey: `${key.apiKey}-rotated` }));
  let attempts = 0;
  const query = request => ({
    async *[Symbol.asyncIterator]() {
      attempts++;
      if (attempts === 1) {
        await writeFile(f.env.CODJIFLO_ANTHROPIC_KEYS_FILE, JSON.stringify({ keys: rotated }));
        yield apiError('rate_limit');
        yield failure;
      } else {
        assert.ok(rotated.some(key => key.apiKey === request.options.env.ANTHROPIC_API_KEY));
        request.options.stderr(rotated.map(key => key.apiKey).join(' '));
        yield { ...success, structured_output: { ...review, summary: rotated.map(key => key.apiKey).join(' ') } };
      }
    },
    close() {},
  });
  const result = await runClaudeReview({ ...f.options, query });
  assert.equal(attempts, 2);
  for (const key of rotated) {
    assert.ok(!f.log().includes(key.apiKey));
    assert.ok(!result.summary.includes(key.apiKey));
  }
});

test('auth, network, model, schema and caller-limit failures never use another key or OAuth', async t => {
  for (const events of [
    [apiError('authentication_failed'), failure], [apiError('model_not_found'), failure],
    [apiError('billing_error', 'Unknown billing failure'), failure],
    [apiError('server_error'), failure],
    [apiError('rate_limit'), { type: 'result', subtype: 'error_max_budget_usd', is_error: true }],
    [apiError('rate_limit'), { type: 'result', subtype: 'error_max_turns', is_error: true }],
    [apiError('rate_limit'), { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true }],
    [{ type: 'result', subtype: 'success', is_error: false }], [],
  ]) await t.test(JSON.stringify(events), async t => {
    const f = await setup(t);
    const captures = [];
    await assert.rejects(runClaudeReview({ ...f.options, query: sessions(events, captures) }));
    assert.equal(captures.length, 1);
    assert.equal(captures[0].closed, true);
  });
  const f = await setup(t);
  await assert.rejects(runClaudeReview({ ...f.options, query: () => { throw new Error('connection reset'); } }), /connection reset/);
});

test('all configured secrets are redacted in events, split stderr, returned reviews and errors', async t => {
  const f = await setup(t);
  const combined = f.keys.map(key => key.apiKey).join(' ');
  const query = request => {
    for (const key of f.keys) {
      request.options.stderr(key.apiKey.slice(0, 7));
      request.options.stderr(key.apiKey.slice(7) + '\n');
    }
    return sessions([{ ...success, structured_output: { ...review, summary: combined } }])(request);
  };
  const result = await runClaudeReview({ ...f.options, query });
  for (const key of f.keys) {
    assert.ok(!f.log().includes(key.apiKey));
    assert.ok(!result.summary.includes(key.apiKey));
  }
  await assert.rejects(runClaudeReview({ ...f.options, query: () => { throw new Error(combined); } }), error => f.keys.every(key => !error.message.includes(key.apiKey)));
});

test('stream redaction protects every split point without dropping ordinary output', () => {
  const key = 'sk-ant-fixture-key';
  for (let split = 1; split < key.length; split++) {
    let text = '';
    const redactor = secretRedactor([key], value => { text += value; });
    redactor.write('prefix ' + key.slice(0, split));
    redactor.write(key.slice(split) + ' suffix');
    redactor.end();
    assert.equal(text, 'prefix [REDACTED] suffix');
  }
});

test('real subprocess stream hook redacts split CLI stdout and stderr', async t => {
  const f = await setup(t);
  let text = '';
  const key = f.keys[0].apiKey;
  const out = secretRedactor([key], value => { text += value; });
  const err = secretRedactor([key], value => { text += value; });
  await runProcess(process.execPath, ['-e', "process.stdout.write(process.env.FIXTURE_SECRET.slice(0,8));process.stderr.write(process.env.FIXTURE_SECRET.slice(0,9));setTimeout(()=>{process.stdout.write(process.env.FIXTURE_SECRET.slice(8));process.stderr.write(process.env.FIXTURE_SECRET.slice(9));},20)"], {
    env: { ...f.env, FIXTURE_SECRET: key }, stream: true,
    streamOutput: { stdout: data => out.write(data), stderr: data => err.write(data) },
  });
  out.end(); err.end();
  assert.equal(text, '[REDACTED][REDACTED]');
});

test('provider environment is cleared for OAuth and explicit proxy retained only for API', () => {
  const env = { HOME: '/fixture', ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_BASE_URL: 'http://fixture', CLAUDE_CODE_OAUTH_TOKEN: 'old', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' };
  const oauth = claudeEnvironment(env);
  for (const name of Object.keys(env).filter(name => name !== 'HOME')) assert.equal(oauth[name], undefined);
  assert.equal(oauth.HOME, '/fixture');
  assert.equal(claudeEnvironment(env, 'selected').ANTHROPIC_API_KEY, 'selected');
  assert.equal(claudeEnvironment(env, 'selected').ANTHROPIC_BASE_URL, 'http://fixture');
});

test('single provider deadline aborts and closes a hung SDK without OAuth', async t => {
  const f = await setup(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let closed = false;
  let signal;
  let sdkStarted;
  const started = new Promise(resolve => { sdkStarted = resolve; });
  const query = request => {
    signal = request.options.abortController.signal;
    sdkStarted();
    return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, close() { closed = true; } };
  };
  const pending = runClaudeReview({ ...f.options, timeoutMs: 100, query });
  // Routing does real filesystem I/O. Advance the provider clock only after the
  // SDK starts so slow CI storage cannot turn this into a pre-start timeout.
  const rejected = assert.rejects(pending, /timed out/);
  await started;
  t.mock.timers.tick(99);
  assert.equal(closed, false);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(closed, true);
  assert.equal(signal.aborted, true);
});

test('provider deadline exhausted by credential routing does not start the SDK or OAuth', async t => {
  const f = await setup(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  let sdkStarted = false;
  let oauthStarted = false;
  const stderr = { write: data => {
    f.options.stderr.write(data);
    // This route is logged after claiming the key and before starting the SDK.
    if (data.startsWith('Claude route: API credential ')) t.mock.timers.setTime(1_100);
  } };
  await assert.rejects(runClaudeReview({
    ...f.options, timeoutMs: 100, stderr,
    query: () => {
      sdkStarted = true;
      return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, close() {} };
    },
    runProcess: async () => { oauthStarted = true; throw new Error('Unexpected OAuth fallback'); },
  }), /timed out/);
  assert.equal(sdkStarted, false);
  assert.equal(oauthStarted, false);
});
