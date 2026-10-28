import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { sdkFixture } from './sdk-fixture.mjs';
import { runProcess } from '../src/runner.mjs';

// No paid calls or live OAuth: HOME/config/state are temporary, API keys are fake,
// and ANTHROPIC_BASE_URL sends the actual installed SDK to a loopback Messages API.
// The fallback executable is the existing fixture CLI, never the user's Claude.
for (const mode of ['success', 'credit-exhaustion', 'rate-limit']) {
  const f = await fixture();
  const api = await sdkFixture({ mode });
  try {
    const keys = Array.from({ length: 3 }, (_, index) => ({ id: `api-${index + 1}`, apiKey: `sk-ant-api03-local-smoke-not-real-${index + 1}` }));
    const keysFile = join(f.temp, 'sdk-keys.json');
    await writeFile(keysFile, JSON.stringify({ keys }), { mode: 0o600 });
    // Disable nonessential network activity, and clear host proxy configuration
    // so even proxy-configured developer machines keep this fixture on loopback.
    const started = Date.now();
    const log = await f.run({ preset: 'claude', mode: 'findings', timeoutMs: 90_000, providerEnv: {
      CODJIFLO_ANTHROPIC_KEYS_FILE: keysFile, ANTHROPIC_BASE_URL: api.url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost',
    } });
    process.stdout.write(log);
    const messages = api.requests.filter(request => request.path.startsWith('/v1/messages') && !request.path.includes('count_tokens'));
    assert.ok(messages.length > 0, 'actual SDK must call the local Messages API');
    const used = new Set(messages.map(request => request.apiKey));
    assert.deepEqual([...used], mode === 'success' ? [keys[0].apiKey] : keys.map(key => key.apiKey));
    assert.ok(messages.some(request => request.body.stream === true), 'actual SDK streaming protocol exercised');
    const verdicts = f.state.posts.filter(post => post.path.endsWith('/reviews'));
    assert.equal(verdicts.length, 1, 'partial attempts must never publish a verdict');
    const published = verdicts[0].body;
    assert.equal(published.event, 'REQUEST_CHANGES');
    assert.equal(published.commit_id, f.head);
    assert.equal(published.comments.at(-1).side, 'RIGHT');
    assert.equal(published.comments.at(-1).line, 2);
    if (mode !== 'success') {
      assert.match(await readFile(f.capture, 'utf8'), /review/i);
      assert.match(published.body, /Fixture review complete/);
    } else {
      assert.match(published.body, /Local SDK protocol fixture review/);
      await assert.rejects(readFile(f.capture), { code: 'ENOENT' });
    }
    if (mode === 'rate-limit') {
      assert.ok(Date.now() - started < 90_000, 'rotate before the 120-second native retry delay');
      const state = JSON.parse(await readFile(f.env.CODJIFLO_CLAUDE_STATE_FILE, 'utf8'));
      for (const key of keys) {
        assert.equal(state.keys[key.id].status, 'cooldown');
        assert.equal(state.keys[key.id].reason, 'rate-limit');
        // Terminal typed 429 events do not expose Retry-After; the adapter
        // conservatively uses its documented 60-second cooldown.
        assert.ok(state.keys[key.id].retryAt >= started + 60_000);
      }
    }
    for (const key of keys) {
      assert.ok(!log.includes(key.apiKey));
      assert.ok(!JSON.stringify(f.state.posts).includes(key.apiKey));
    }
    console.log(`PASS actual Agent SDK local Messages protocol: ${mode}`);
  } finally { await api.close(); await f.close(); }
}

// Exercise the installed SDK's permission consumer, not the adapter's options
// object. Each isolated run requests the same real tools. The relaxed controls
// prove that denied mutations, absent external MCP starts, and absent transcripts
// in the production run are not inert fixture artifacts.
for (const scenario of ['production', 'relaxed-default-settings', 'relaxed-project-settings']) {
  const relaxed = scenario !== 'production';
  const f = await fixture();
  const target = join(f.repo, 'a.js');
  const original = await readFile(target, 'utf8');
  const bashMarker = join(f.repo, 'allowed-bash-marker');
  const mcpMarker = join(f.temp, 'external-mcp-started');
  const projectMcpMarker = join(f.temp, 'project-mcp-started');
  const hookMarker = join(f.temp, 'project-hook-started');
  const attempts = [
    { id: 'toolu_security_read', name: 'Read', input: { file_path: target } },
    { id: 'toolu_security_write', name: 'Write', input: { file_path: target, content: 'CONTROL WRITE\n' } },
    { id: 'toolu_security_edit', name: 'Edit', input: { file_path: target, old_string: relaxed ? 'CONTROL WRITE' : 'new', new_string: 'CONTROL EDIT' } },
    { id: 'toolu_security_bash', name: 'Bash', input: { command: `printf allowed > '${bashMarker}'`, description: 'Local smoke positive control' } },
  ];
  const observed = new Map();
  const api = await sdkFixture({ responseContent({ body }) {
    for (const message of body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === 'tool_result') observed.set(block.tool_use_id, block);
      }
    }
    const next = attempts.find(attempt => !observed.has(attempt.id));
    return next ? [{ type: 'tool_use', ...next }] : undefined;
  } });
  try {
    const configDir = f.env.CLAUDE_CONFIG_DIR;
    await mkdir(configDir, { recursive: true });
    const mcpScript = join(f.temp, 'external-mcp.mjs');
    // A real local stdio MCP server: starting it leaves evidence independently
    // of whether the model ever asks for an MCP tool. It never uses the network.
    await writeFile(mcpScript, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(mcpMarker)}, 'started');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-security-smoke', version: '1' } }
    : request.method === 'tools/list' ? { tools: [] } : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
`);
    const externalConfig = JSON.stringify({ mcpServers: {
      'local-security-smoke': { type: 'stdio', command: process.execPath, args: [mcpScript] },
    } });
    // Cover both the default HOME location and the custom-config-dir location.
    await writeFile(join(f.env.HOME, '.claude.json'), externalConfig);
    await writeFile(join(configDir, '.claude.json'), externalConfig);
    const projectMcpScript = join(f.temp, 'project-mcp.mjs');
    await writeFile(projectMcpScript, (await readFile(mcpScript, 'utf8')).replace(JSON.stringify(mcpMarker), JSON.stringify(projectMcpMarker)));
    await writeFile(join(f.repo, '.mcp.json'), JSON.stringify({ mcpServers: {
      'project-security-smoke': { type: 'stdio', command: process.execPath, args: [projectMcpScript] },
    } }));
    await mkdir(join(f.repo, '.claude'), { recursive: true });
    await writeFile(join(f.repo, '.claude', 'settings.json'), JSON.stringify({
      enableAllProjectMcpServers: true,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `printf started > '${hookMarker}'` }] }] },
    }));
    const keysFile = join(f.temp, 'sdk-security-keys.json');
    await writeFile(keysFile, JSON.stringify({ keys: Array.from({ length: 3 }, (_, index) => ({ id: `security-${index}`, apiKey: `sk-ant-api03-local-security-not-real-${index}` })) }), { mode: 0o600 });
    // Isolate SDK parent-side initialization too, not only its native child.
    const output = await runProcess(process.execPath, ['--input-type=module', '-e', `
      import { runClaudeReview } from ${JSON.stringify(new URL('../src/claude.mjs', import.meta.url).href)};
      import { query as sdkQuery } from ${JSON.stringify(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))};
      const result = await runClaudeReview({
        preset: { model: 'claude-opus-4-6', effort: 'high' },
        prompt: 'Exercise the local protocol security fixture, then return its review.',
        cwd: process.cwd(), timeoutMs: 90_000,
        stdout: { write() {} }, stderr: process.stderr,
        runProcess() { throw new Error('Security smoke must not fall back to OAuth CLI'); },
        ${relaxed ? `query({ prompt, options }) {
          return sdkQuery({ prompt, options: {
            ...options, allowedTools: [...options.allowedTools, 'Write', 'Edit'],
            strictMcpConfig: false, persistSession: true,
            ${scenario === 'relaxed-project-settings' ? "settingSources: ['project']," : ''}
          } });
        },` : ''}
      });
      console.log(JSON.stringify(result));
    `], {
      cwd: f.repo, timeoutMs: 100_000,
      env: {
        ...f.env, CODJIFLO_ANTHROPIC_KEYS_FILE: keysFile, ANTHROPIC_BASE_URL: api.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost',
      },
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.summary, api.result.summary);
    const read = observed.get('toolu_security_read');
    assert.ok(read && !read.is_error, 'Read must succeed before Edit to rule out the unread-file precondition');
    assert.ok(JSON.stringify(read.content).includes('changed'), 'Read must return actual sentinel file contents');
    for (const id of ['toolu_security_write', 'toolu_security_edit']) {
      const toolResult = observed.get(id);
      assert.ok(toolResult, `${scenario}: ${id} must return a native tool result`);
      if (relaxed) {
        assert.ok(!toolResult.is_error, `${scenario}: ${id} must succeed with relaxed native permissions`);
      } else {
        assert.equal(toolResult.is_error, true, `${id} must return a native tool error to the model`);
        assert.match(JSON.stringify(toolResult.content), /permission|not allowed|denied|not permitted/i, `${id} must fail for permissions, not malformed tool input`);
      }
    }
    assert.equal(await readFile(target, 'utf8'), relaxed ? 'CONTROL EDIT\n' : original,
      `${scenario}: native Write and Edit must ${relaxed ? 'both mutate' : 'leave unchanged'} the sentinel`);
    assert.ok(observed.has('toolu_security_bash') && !observed.get('toolu_security_bash').is_error);
    assert.equal(await readFile(bashMarker, 'utf8'), 'allowed', 'allowed Bash must actually execute');
    // The default-settings control reverses both external-MCP exclusions.
    // The project-only control targets project configuration; user MCP loading
    // is not part of its assertion because its settings source was excluded.
    const mcpMarkers = scenario === 'relaxed-project-settings' ? [projectMcpMarker] : [mcpMarker, projectMcpMarker];
    for (const marker of mcpMarkers) {
      if (relaxed) assert.equal(await readFile(marker, 'utf8'), 'started', `${scenario}: external MCP must really start`);
      else await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
    // Hooks are a positive control for relaxed settings, not a production
    // contract. Production retains the SDK's settings behavior, while this
    // fixture never grants Write/Edit through project settings.
    if (relaxed) assert.equal(await readFile(hookMarker, 'utf8'), 'started', `${scenario}: project SessionStart hook must execute`);
    // Session transcripts live under projects, not arbitrary config files.
    const transcripts = [];
    for (const root of [configDir, f.env.HOME]) {
      const entries = await readdir(root, { recursive: true });
      transcripts.push(...entries.filter(name => name.endsWith('.jsonl')).map(name => join(root, name)));
    }
    if (relaxed) {
      assert.ok(transcripts.length > 0, `${scenario}: persistence control must save a real conversation transcript`);
      const contents = await Promise.all(transcripts.map(path => readFile(path, 'utf8')));
      assert.ok(contents.some(content => content.includes('toolu_security_write') && content.includes('toolu_security_edit')),
        `${scenario}: saved transcript must contain this run's actual tool conversation`);
    } else {
      assert.deepEqual(transcripts, [], 'isolated HOME/config must contain no persisted session transcript');
    }
    console.log(`PASS actual Agent SDK native security boundaries and project settings: ${scenario}`);
  } finally { await api.close(); await f.close(); }
}
