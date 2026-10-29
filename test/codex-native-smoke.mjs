// Opt-in paid-model smoke. Uses the installed Codex CLI and real sandbox, with
// native review publication confined to the loopback GitHub fixture.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture.mjs';

if (process.env.CODEX_NATIVE_SMOKE !== '1') throw new Error('Opt in with CODEX_NATIVE_SMOKE=1; this smoke calls the real paid model');
const temp = await mkdtemp(join(tmpdir(), 'codjiflo-native-smoke-'));
const probe = join(temp, 'source-census.py');
const secret = join(temp, 'nonce');
const nonce = randomUUID();
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
let f;
try {
  await writeFile(secret, nonce);
  await writeFile(probe, `import ast, errno, json, os, pathlib, tempfile
root = pathlib.Path.cwd()
source = root / 'example.py'
tree = ast.parse(source.read_text())
assignments = [node.value.value for node in tree.body if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)]
assert assignments == [42], assignments
runtime = pathlib.Path(os.environ['TMPDIR']).parent
assert runtime != root and runtime not in root.parents and root not in runtime.parents
with tempfile.NamedTemporaryFile() as handle:
    handle.write(b'private runtime lock')
    handle.flush()
    assert pathlib.Path(handle.name).is_relative_to(runtime)
cache = pathlib.Path(os.environ['UV_CACHE_DIR'])
cache.mkdir(parents=True, exist_ok=True)
(cache / 'probe-lock').write_text('private')
def denied(path):
    try:
        with open(path, 'r+'):
            pass
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
            return True
        raise
    return False
alias = runtime / 'checkout-alias'
alias.symlink_to(root, target_is_directory=True)
proof = {'kind': 'codjiflo-native-runtime', 'nonce': pathlib.Path(${JSON.stringify(secret)}).read_text(), 'assignments': assignments, 'scratch': str(runtime), 'repoDenied': denied(source), 'evidenceDenied': denied(root.parent / 'schema.json'), 'hostDenied': denied(pathlib.Path(${JSON.stringify(secret)})), 'aliasDenied': denied(alias / 'example.py')}
assert all(proof[name] for name in ('repoDenied', 'evidenceDenied', 'hostDenied', 'aliasDenied')), proof
print(json.dumps(proof))
`);
  f = await fixture({
    filename: 'example.py', oldLine: '# previous source', newLine: 'value = 42',
    headPrompt: `Review the entire supplied source diff. This is an isolated source-only smoke repository, not a native drawing review. Before giving a verdict, run the trusted read-only source census exactly once with: uv run --offline --no-project --no-managed-python --python python3 python ${quote(probe)}. The census parses example.py and checks that runtime scratch works while opening repository, evidence and host files for writing is denied. Its negative permission probes do not modify those files. If it fails, return INCOMPLETE with the actual blocker; never fabricate a successful probe. Inspect the source and report any genuine defects, otherwise approve. Mention the source census result and its observed nonce in your final summary.`,
  });
  const inherited = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME', 'PATH'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const stdout = await f.run({ full: true, timeoutMs: 15 * 60 * 1000, providerEnv: {
    ...inherited,
    CODJIFLO_CODEX_BIN: process.env.CODJIFLO_CODEX_BIN || 'codex',
    ...(process.env.CODJIFLO_SOL_MODEL ? { CODJIFLO_SOL_MODEL: process.env.CODJIFLO_SOL_MODEL } : {}),
  } });
  const events = stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const commands = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution').map(event => event.item);
  const proof = commands.filter(item => item.exit_code === 0 && item.command.includes('uv run') && item.command.includes(probe)).flatMap(item => item.aggregated_output.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })).find(value => value.kind === 'codjiflo-native-runtime' && value.nonce === nonce);
  assert.ok(proof, 'real model must execute the uv source census and consume its evidence');
  assert.deepEqual(proof.assignments, [42]);
  for (const name of ['repoDenied', 'evidenceDenied', 'hostDenied', 'aliasDenied']) assert.equal(proof[name], true);
  assert.ok(events.some(event => event.type === 'turn.completed'));
  const posts = f.state.posts.filter(post => post.path.endsWith('/reviews'));
  assert.equal(posts.length, 1, 'actual structured model verdict must reach native loopback publication');
  assert.match(posts[0].body.body, new RegExp(nonce), 'publication must use consumed census evidence');
  assert.ok(['APPROVE', 'REQUEST_CHANGES'].includes(posts[0].body.event));
  assert.equal(await readFile(secret, 'utf8'), nonce);
  await assert.rejects(readFile(join(proof.scratch, 'uv-cache', 'probe-lock')), { code: 'ENOENT' });
  console.log(JSON.stringify({ nativeRuntimeProof: proof, publishedEvent: posts[0].body.event, reviewCount: posts.length }));
} finally {
  if (f) await f.close();
  await rm(temp, { recursive: true, force: true });
}
