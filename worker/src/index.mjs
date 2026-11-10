// Codjiflo webhook relay: turns a GitHub App `issue_comment` delivery that
// mentions the reviewer into one workflow_dispatch of the central review
// workflow. It decides nothing about authorization or command syntax: the
// workflow gate re-reads the comment from GitHub and applies the allowlist.

const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function signed(secret, signature, body) {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(signature ?? '')?.[1];
  if (!secret || !hex) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16)), body);
}

// Returns the dispatch inputs for a human PR comment mentioning the reviewer.
export function mention(name, event) {
  if (name !== 'issue_comment' || event?.action !== 'created' || !event.issue?.pull_request) return null;
  if (event.comment?.user?.type === 'Bot' || !/@codjiflo/i.test(event.comment?.body ?? '')) return null;
  return { repository: event.repository.full_name, 'comment-id': String(event.comment.id) };
}

async function appJwt(env) {
  const pem = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(env.APP_PRIVATE_KEY ?? '')?.[1];
  if (!pem) throw new Error('APP_PRIVATE_KEY must be a PKCS#8 PEM (convert GitHub\'s key with `openssl pkcs8 -topk8 -nocrypt`)');
  const der = Uint8Array.from(atob(pem.replace(/\s/g, '')), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  // Backdated for clock drift; GitHub rejects lifetimes over ten minutes.
  const claims = { iat: now - 60, exp: now + 300, iss: String(env.APP_ID) };
  const unsigned = `${base64url(encoder.encode('{"alg":"RS256","typ":"JWT"}'))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  return `${unsigned}.${base64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned)))}`;
}

async function github(env, token, path, body) {
  const response = await fetch(`${env.GITHUB_API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codjiflo-webhook-relay', ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function dispatch(env, inputs) {
  const jwt = await appJwt(env);
  const installation = await github(env, jwt, `/repos/${env.DISPATCH_REPOSITORY}/installation`);
  // Scoped to the one permission and repository the dispatch needs.
  const { token } = await github(env, jwt, `/app/installations/${installation.id}/access_tokens`, {
    repositories: [env.DISPATCH_REPOSITORY.split('/')[1]], permissions: { actions: 'write' },
  });
  await github(env, token, `/repos/${env.DISPATCH_REPOSITORY}/actions/workflows/${env.DISPATCH_WORKFLOW}/dispatches`, { ref: env.DISPATCH_REF, inputs });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only\n', { status: 405 });
    const delivery = request.headers.get('X-GitHub-Delivery');
    const name = request.headers.get('X-GitHub-Event');
    const report = (status, outcome, detail = {}) => {
      console.log(JSON.stringify({ delivery, event: name, outcome, ...detail }));
      return Response.json({ outcome }, { status });
    };
    const body = await request.arrayBuffer();
    if (!await signed(env.WEBHOOK_SECRET, request.headers.get('X-Hub-Signature-256'), body)) return report(401, 'bad-signature');
    const inputs = mention(name, JSON.parse(new TextDecoder().decode(body)));
    if (!inputs) return report(200, 'ignored');
    // Answer GitHub only after the dispatch settles: a failed delivery stays
    // visible in the App's delivery log and can be redelivered.
    try {
      await dispatch(env, inputs);
    } catch (error) {
      return report(502, 'dispatch-failed', { ...inputs, error: error.message });
    }
    return report(202, 'dispatched', inputs);
  },
};
