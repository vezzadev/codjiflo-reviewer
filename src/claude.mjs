import { schema } from './prompt.mjs';
import { loadClaudeCredentials, claimClaudeCredential, markClaudeUnavailable } from './claude-credentials.mjs';

const REVIEW_TIMEOUT_MS = 45 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

// Keep a possible secret prefix between writes: stderr chunks need not align with
// either UTF-8 characters (decoded by the runner/SDK) or credential boundaries.
export function secretRedactor(secrets, write) {
  let values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  let hold = Math.max(0, ...values.map(value => value.length - 1));
  let pending = '';
  const redact = value => values.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
  return {
    redact,
    add(secrets) {
      values = [...new Set([...values, ...secrets.filter(Boolean)])].sort((a, b) => b.length - a.length);
      hold = Math.max(0, ...values.map(value => value.length - 1));
    },
    write(chunk) {
      pending = redact(pending + chunk);
      const end = Math.max(0, pending.length - hold);
      if (end) write(pending.slice(0, end));
      pending = pending.slice(end);
    },
    end() { if (pending) write(redact(pending)); pending = ''; },
  };
}

// SDK env values explicitly unset inherited credentials too. The SDK accepts
// undefined values, while spawn omits them. Never obtain or copy OAuth tokens.
export function claudeEnvironment(env, apiKey) {
  const result = { ...env };
  for (const name of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
    if (/^ANTHROPIC_/.test(name) || /^CLAUDE_CODE_(?:OAUTH|USE_|API_KEY|SUBAGENT_MODEL|AWS|VERTEX|FOUNDRY)/.test(name) || name === 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS') result[name] = undefined;
  }
  if (apiKey) {
    result.ANTHROPIC_API_KEY = apiKey;
    // Explicitly configured API proxies are supported, including the local smoke
    // fixture. They must be trusted: this endpoint receives the selected key.
    if (env.ANTHROPIC_BASE_URL) result.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }
  return result;
}

function apiErrorText(event) {
  return (event.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function resetFromText(text, now) {
  // Anthropic's workspace/user-defined spend-limit response names a reset date.
  const match = /(?:reset|resets|until|on|at)\s+(?:(?:at|on)\s+)?(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?)/i.exec(text);
  const value = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(value) && value > now ? value : null;
}

// Only SDK-designated API error messages are evidence. Ordinary assistant prose,
// subscription rate_limit_event warnings, and result.errors are not API errors.
export function classifyClaudeQuota(event, now = Date.now(), retryDelayMs) {
  if (event?.type !== 'assistant' || !event.error) return null;
  const text = apiErrorText(event);
  if (['rate_limit', 'invalid_request', 'billing_error'].includes(event.error)) {
    if (/\benforced_spend_limit_reached\b/.test(text) || /(?:^|API Error:\s*400\s*[^\n]*?"message"\s*:\s*")You have reached your specified (?:workspace )?API usage limits\b/.test(text)) {
      return { status: 'exhausted', retryAt: resetFromText(text, now), reason: 'spend-limit' };
    }
    // The SDK normalizes the API's full credit-balance sentence to this exact
    // synthetic billing_error text before emitting the terminal error result.
    if ((event.error === 'billing_error' && text === 'Credit balance is too low') || /\bYour credit balance is too low to access the Anthropic API\b/i.test(text) || /\bInsufficient (?:API )?credits\b/i.test(text)) {
      return { status: 'exhausted', retryAt: null, reason: 'credit-balance' };
    }
  }
  if (event.error === 'rate_limit') {
    return { status: 'cooldown', retryAt: now + (Number.isFinite(retryDelayMs) && retryDelayMs > 0 ? retryDelayMs : RATE_LIMIT_COOLDOWN_MS), reason: 'rate-limit' };
  }
  return null;
}

function structuredResult(result) {
  if (!result || result.subtype !== 'success' || result.is_error) throw new Error('Claude did not complete successfully');
  if (!result.structured_output) throw new Error('Claude returned no structured_output');
  return result.structured_output;
}

async function sdkAttempt({ query, credential, preset, prompt, cwd, env, remaining, stdout, stderr, redact }) {
  // Check before creating the timeout promise: an executor rejection would still
  // let query() start with a live controller after credential routing used the budget.
  const timeoutMs = remaining();
  const controller = new AbortController();
  let session;
  let timer;
  let lastApiError;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      session?.close();
      reject(new Error('Claude review timed out (total provider deadline)'));
    }, timeoutMs);
  });
  try {
    session = query({ prompt, options: {
      cwd, env: claudeEnvironment(env, credential.apiKey),
      model: env.CODJIFLO_OPUS_MODEL || preset.model, effort: preset.effort,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], permissionMode: 'dontAsk',
      strictMcpConfig: true, persistSession: false, includePartialMessages: true,
      outputFormat: { type: 'json_schema', schema },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      abortController: controller, stderr: data => stderr.write(data),
      // Omission deliberately retains user/project/local settings and CLAUDE.md.
    } });
    const consume = async () => {
      for await (const event of session) {
        stdout.write(`${redact(JSON.stringify(event))}\n`);
        if (event.type === 'system' && event.subtype === 'api_retry' && event.error === 'rate_limit' && event.error_status === 429) {
          // A documented API retry proves this request was rate-limited. Stop
          // before a long internal retry loop; no response body/headers are
          // exposed here, so this evidence only authorizes a temporary cooldown.
          session.close();
          return { quota: classifyClaudeQuota({ type: 'assistant', error: 'rate_limit' }, Date.now(), event.retry_delay_ms) };
        }
        if (event.type === 'assistant') lastApiError = event.error ? event : undefined;
        if (event.type === 'result') {
          if (event.subtype === 'success' && !event.is_error) return { result: structuredResult(event) };
          // Limits imposed by the caller or structured-output validation never
          // authorize falling back to a paid subscription.
          const quota = ['success', 'error_during_execution'].includes(event.subtype) ? classifyClaudeQuota(lastApiError) : null;
          if (quota) return { quota };
          throw new Error(`Claude did not complete successfully (${event.subtype})`);
        }
      }
      throw new Error('Claude SDK ended without a terminal result');
    };
    return await Promise.race([consume(), timeout]);
  } finally {
    clearTimeout(timer);
    session?.close();
    await session?.return?.();
    stderr.end();
  }
}

export async function runClaudeReview({ preset, prompt, cwd, env = process.env, runProcess, query, timeoutMs = REVIEW_TIMEOUT_MS, stdout = process.stdout, stderr = process.stderr }) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('Claude review timed out (total provider deadline)');
    return value;
  };
  const config = await loadClaudeCredentials(env);
  const secrets = config.credentials.map(credential => credential.apiKey);
  const output = secretRedactor(secrets, data => stdout.write(data));
  const errors = secretRedactor(secrets, data => stderr.write(data));
  const safeResult = result => JSON.parse(output.redact(JSON.stringify(result)));
  try {
    if (config.mode === 'api-pool') {
      const attempted = [];
      while (true) {
        remaining();
        const credential = await claimClaudeCredential(config, attempted);
        const currentSecrets = config.credentials.map(value => value.apiKey);
        if (credential) currentSecrets.push(credential.apiKey);
        output.add(currentSecrets);
        errors.add(currentSecrets);
        if (!credential) break;
        attempted.push(credential.id);
        stderr.write(`Claude route: API credential ${credential.id}\n`);
        const sdkQuery = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
        const attempt = await sdkAttempt({ query: sdkQuery, credential, preset, prompt, cwd, env, remaining, stdout: output, stderr: errors, redact: output.redact });
        if (attempt.result) return safeResult(attempt.result);
        await markClaudeUnavailable(config, credential, attempt.quota);
        stderr.write(`Claude credential ${credential.id} unavailable (${attempt.quota.reason})\n`);
      }
      stderr.write('Claude route: eligible API credentials unavailable; using existing CLI OAuth login\n');
    } else {
      stderr.write('Claude route: no API key configuration; using existing CLI OAuth login\n');
    }
    const oauthEnv = claudeEnvironment(env);
    let auth;
    try {
      auth = JSON.parse(await runProcess(env.CODJIFLO_CLAUDE_BIN || 'claude', ['auth', 'status', '--json'], { cwd, env: oauthEnv, timeoutMs: remaining() }));
    } catch {
      throw new Error('Claude CLI OAuth status could not be verified; run claude auth login on this runner');
    }
    if (auth.loggedIn !== true || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty') {
      throw new Error('Claude CLI fallback requires an existing first-party claude.ai OAuth login');
    }
    const text = await runProcess(env.CODJIFLO_CLAUDE_BIN || 'claude', [
      '--print', '--model', env.CODJIFLO_OPUS_MODEL || preset.model, '--effort', preset.effort,
      '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
      '--no-session-persistence', '--strict-mcp-config', '--allowedTools', 'Read,Grep,Glob,Bash',
      '--permission-mode', 'dontAsk',
    ], { cwd, env: oauthEnv, input: prompt, stream: true, timeoutMs: remaining(),
      streamOutput: { stdout: data => output.write(data), stderr: data => errors.write(data) } });
    const events = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    return safeResult(structuredResult(events.findLast(event => event.type === 'result')));
  } catch (error) {
    // No raw SDK error/cause escapes into workflow logs or GitHub failure posts.
    throw new Error(output.redact(error?.message ?? 'Claude review failed'));
  } finally {
    output.end();
    errors.end();
  }
}
