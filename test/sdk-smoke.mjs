import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { sdkFixture } from './sdk-fixture.mjs';

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
