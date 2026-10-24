import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { configureClaudeCredentials, loadClaudeCredentials, getClaudeCredentialStatus, resetClaudeCredentials } from '../src/claude-credentials.mjs';

const usage = 'Usage: node scripts/claude-keys.mjs configure [--stdin] | status | reset [ID ...]\nconfigure prompts for three hidden API keys and optional quota groups (default: api-N).\n--stdin reads one JSON object {"keys":[{"id":"api-1","apiKey":"...","quotaGroup":"pool"}, ...]} from a secure pipe; never pass secrets in argv.\nreset without IDs clears all blocks and recovers corrupt state; remove a stale .lock only after confirming its owner is not running.';

async function promptConfiguration() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive configuration requires a terminal; use configure --stdin with a secure pipe instead');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  output.isTTY = true;
  const reader = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  reader.on('SIGINT', cancel);
  reader.on('close', cancel);
  try {
    const keys = [];
    for (let index = 1; index <= 3; index++) {
      const id = `api-${index}`;
      process.stdout.write(`${id} API key (hidden): `);
      hidden = true;
      let apiKey;
      try { apiKey = await reader.question('', { signal: cancellation.signal }); } finally { hidden = false; process.stdout.write('\n'); }
      const quotaGroup = (await reader.question(`${id} quota group [${id}]: `, { signal: cancellation.signal })).trim() || id;
      keys.push({ id, apiKey, quotaGroup });
    }
    return { keys };
  } finally { reader.close(); }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'configure' && (args.length === 0 || (args.length === 1 && args[0] === '--stdin'))) {
    let value;
    if (args[0] === '--stdin') {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 65536) throw new Error('Configuration input exceeds size limit');
      }
      try { value = JSON.parse(input); } catch { throw new Error('Invalid configuration JSON'); }
    } else value = await promptConfiguration();
    await configureClaudeCredentials(process.env, value);
    console.log('Configured three Anthropic API keys in the private local credential file.');
  } else if (command === 'status' && args.length === 0) {
    const config = await loadClaudeCredentials();
    console.log(JSON.stringify(await getClaudeCredentialStatus(config), null, 2));
  } else if (command === 'reset' && args.every(id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(id))) {
    await resetClaudeCredentials(await loadClaudeCredentials(), args);
    console.log('Claude routing blocks reset.');
  } else if (['--help', '-h'].includes(command) && args.length === 0) {
    console.log(usage);
  } else throw new Error(usage);
} catch (error) {
  // All parsing/validation errors above are fixed messages, never input excerpts.
  if (error.name === 'AbortError') {
    console.error('Claude credential configuration cancelled.');
    process.exitCode = 130;
  } else {
    console.error(error.message?.startsWith('Claude credentials:') || error.message === usage || ['Interactive configuration requires a terminal; use configure --stdin with a secure pipe instead', 'Configuration input exceeds size limit', 'Invalid configuration JSON'].includes(error.message) ? error.message : 'Claude credential operation failed');
    process.exitCode = 1;
  }
}
