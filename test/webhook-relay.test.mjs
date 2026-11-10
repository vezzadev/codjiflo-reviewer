import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import relay from '../worker/src/index.mjs';

const secret = 'fixture-webhook-secret';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// Loopback GitHub: verifies the App JWT signature the way GitHub would.
async function githubFixture({ dispatchStatus = 204 } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const bearer = request.headers.authorization.replace(/^Bearer /, '');
    requests.push({ method: request.method, path: request.url, bearer, body: body ? JSON.parse(body) : undefined });
    const appAuthenticated = () => {
      const [header, claims, signature] = bearer.split('.');
      const { iss, iat, exp } = JSON.parse(Buffer.from(claims, 'base64url'));
      const now = Date.now() / 1000;
      return verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))
        && iss === '2540540' && iat <= now && exp > now && exp - iat <= 600;
    };
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/repos/vezzadev/codjiflo-reviewer/installation' && appAuthenticated()) return response.end('{"id":77}');
    if (request.url === '/app/installations/77/access_tokens' && appAuthenticated()) return response.end('{"token":"installation-token"}');
    if (request.url === '/repos/vezzadev/codjiflo-reviewer/actions/workflows/review.yml/dispatches' && bearer === 'installation-token') {
      response.statusCode = dispatchStatus;
      return response.end(dispatchStatus === 204 ? undefined : '{"message":"Resource not accessible by integration"}');
    }
    response.statusCode = 401; response.end('{"message":"Bad credentials"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    WEBHOOK_SECRET: secret, APP_ID: '2540540', APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    DISPATCH_REPOSITORY: 'vezzadev/codjiflo-reviewer', DISPATCH_WORKFLOW: 'review.yml', DISPATCH_REF: 'main',
  };
  return { requests, env, close: () => new Promise(resolve => server.close(resolve)) };
}

const comment = (overrides = {}) => ({
  action: 'created', repository: { full_name: 'pedropaulovc/solidworks-pool' },
  issue: { number: 228, pull_request: {} },
  comment: { id: 6734059412, body: 'Ready. @codjiflo review full', user: { login: 'pedropaulovc', type: 'User' } },
  ...overrides,
});

function deliver(env, event, { name = 'issue_comment', key = secret } = {}) {
  const body = JSON.stringify(event);
  return relay.fetch(new Request('https://relay.example/', {
    method: 'POST', body,
    headers: { 'X-GitHub-Event': name, 'X-GitHub-Delivery': 'fixture-delivery', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', key).update(body).digest('hex')}` },
  }), env);
}

test('a signed PR mention from any repository dispatches the central review workflow', async () => {
  const f = await githubFixture();
  try {
    const response = await deliver(f.env, comment());
    assert.equal(response.status, 202);
    assert.deepEqual(f.requests.map(request => request.path), [
      '/repos/vezzadev/codjiflo-reviewer/installation',
      '/app/installations/77/access_tokens',
      '/repos/vezzadev/codjiflo-reviewer/actions/workflows/review.yml/dispatches',
    ]);
    assert.deepEqual(f.requests[1].body, { repositories: ['codjiflo-reviewer'], permissions: { actions: 'write' } });
    assert.deepEqual(f.requests[2].body, { ref: 'main', inputs: { repository: 'pedropaulovc/solidworks-pool', 'comment-id': '6734059412' } });
  } finally { await f.close(); }
});

test('forged, unsigned-for-this-secret and non-POST requests never reach GitHub', async () => {
  const f = await githubFixture();
  try {
    assert.equal((await deliver(f.env, comment(), { key: 'another-secret' })).status, 401);
    assert.equal((await deliver({ ...f.env, WEBHOOK_SECRET: '' }, comment(), { key: '' })).status, 401);
    assert.equal((await relay.fetch(new Request('https://relay.example/'), f.env)).status, 405);
    assert.deepEqual(f.requests, []);
  } finally { await f.close(); }
});

test('deliveries that cannot be review requests are acknowledged without a dispatch', async () => {
  const f = await githubFixture();
  try {
    const ignored = [
      [comment({ action: 'edited' })],
      [comment({ issue: { number: 7 } })],
      [comment({ comment: { id: 1, body: 'Looks good to me', user: { login: 'pedropaulovc', type: 'User' } } })],
      [comment({ comment: { id: 2, body: '@codjiflo review', user: { login: 'codjiflo[bot]', type: 'Bot' } } })],
      [{ zen: 'Keep it logically awesome.' }, { name: 'ping' }],
      [comment(), { name: 'pull_request_review_comment' }],
    ];
    for (const [event, options] of ignored) {
      const response = await deliver(f.env, event, options);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { outcome: 'ignored' });
    }
    assert.deepEqual(f.requests, []);
  } finally { await f.close(); }
});

test('a rejected dispatch fails the delivery so GitHub records it for redelivery', async () => {
  const f = await githubFixture({ dispatchStatus: 403 });
  try {
    const response = await deliver(f.env, comment());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { outcome: 'dispatch-failed' });
  } finally { await f.close(); }
});
