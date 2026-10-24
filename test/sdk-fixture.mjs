import { createServer } from 'node:http';

// This is a protocol fixture, not a fake SDK. The installed Agent SDK launches
// its real runtime and sends real Messages requests to this loopback endpoint.
export async function sdkFixture({ mode = 'success' } = {}) {
  const requests = [];
  const result = { verdict: 'REQUEST_CHANGES', summary: 'Local SDK protocol fixture review.', findings: [
    { path: 'a.js', side: 'RIGHT', start_line: 1, line: 2, priority: 'P2', disposition: 'blocking', title: 'Fixture finding', body: 'Concrete local fixture failure scenario.' },
  ] };
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: request.url, apiKey: request.headers['x-api-key'], body });
      if (request.url.includes('/messages/count_tokens')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ input_tokens: 20 }));
        return;
      }
      if (!request.url.startsWith('/v1/messages')) {
        response.setHeader('Content-Type', 'application/json');
        response.end('{}');
        return;
      }
      if (mode === 'credit-exhaustion') {
        // A deterministic terminal API error (not a transient 429): all three
        // keys exhaust, then the entry point must use the fixture OAuth CLI.
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }, request_id: 'req_local_fixture' }));
        return;
      }
      if (mode === 'rate-limit') {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your organization rate limit.' }, request_id: 'req_local_rate_limit' }));
        return;
      }
      const structuredTool = body.tools?.find(tool => /structured.?output/i.test(tool.name));
      const alreadyCalled = body.messages?.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.name === structuredTool?.name));
      const content = structuredTool && !alreadyCalled
        ? [{ type: 'tool_use', id: 'toolu_fixture_structured', name: structuredTool.name, input: result }]
        : [{ type: 'text', text: JSON.stringify(result) }];
      const message = { id: 'msg_local_fixture', type: 'message', role: 'assistant', model: body.model, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
      if (!body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const emit = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
      const block = content[0];
      emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } });
      emit('message_stop', {});
      response.end();
    } catch {
      response.writeHead(500);
      response.end('Fixture protocol error');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests, result, url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
