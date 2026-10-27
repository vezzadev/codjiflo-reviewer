import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { prompt } from './prompt.mjs';

export const MAX_INLINE_INPUT = 512 * 1024;
const MAX_INVENTORY_RECORD = 6000;

// Generated names only: repository paths are JSON data, never staging paths or
// shell syntax. The helper is trusted runner code, not executable PR content.
const reader = `import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [name, startText = '0', sizeText = '6000'] = process.argv.slice(2);
if (!['inventory.jsonl', 'review-scope.diff', 'pr-patches.json'].includes(name)) throw new Error('Unknown evidence file');
const start = Number(startText), size = Number(sizeText);
if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > 6000) throw new Error('Invalid byte range (maximum 6000)');
const file = await open(join(fileURLToPath(new URL('.', import.meta.url)), name), 'r');
try {
 const total = (await file.stat()).size;
 if (start > total) throw new Error('Range outside evidence');
 const buffer = Buffer.alloc(Math.min(size + 4, total - start));
 const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
 if (bytesRead && (buffer[0] & 192) === 128) throw new Error('Start is not a UTF-8 boundary');
 let end = Math.min(size, bytesRead);
 while (end < bytesRead && (buffer[end] & 192) === 128) end--;
 if (!end && bytesRead) throw new Error('Increase range size to fit a UTF-8 character');
 console.log(JSON.stringify({ start, next: start + end, total, bytes: end }));
 process.stdout.write(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
} finally { await file.close(); }
`;

function scopeFiles(numstat) {
  const tokens = numstat.split('\0');
  const files = [];
  for (let index = 0; index < tokens.length - 1;) {
    const row = tokens[index++];
    const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
    if (first < 0 || second < 0) throw new Error('Invalid scope inventory');
    const additions = row.slice(0, first), deletions = row.slice(first + 1, second);
    let filename = row.slice(second + 1), previous_filename;
    if (filename === '') { previous_filename = tokens[index++]; filename = tokens[index++]; }
    if (!filename || (previous_filename !== undefined && !previous_filename)) throw new Error('Incomplete scope inventory');
    files.push({ filename, ...(previous_filename === undefined ? {} : { previous_filename }), additions: additions === '-' ? null : Number(additions), deletions: deletions === '-' ? null : Number(deletions) });
  }
  return files;
}

export async function reviewInput({ preset, options, temp, cwd, git }) {
  const inline = prompt(options);
  if (preset.cli !== 'codex' || inline.length <= MAX_INLINE_INPUT) return inline;
  // Methodology is never hidden behind evidence reads. Refuse an oversized
  // custom recipe before invoking the provider, rather than truncate it.
  if (prompt({ ...options, diff: '', currentDiff: '' }).length > MAX_INLINE_INPUT - 16000) {
    throw new Error('Review instructions exceed the inline Codex input budget; no review completed and no instructions were truncated');
  }
  const parent = resolve(temp), checkout = resolve(cwd);
  const directory = await mkdtemp(join(parent, 'review-evidence-'));
  const fromCheckout = relative(checkout, directory);
  if (fromCheckout === '' || (!fromCheckout.startsWith('..' + sep) && fromCheckout !== '..' && !isAbsolute(fromCheckout))) throw new Error('Review evidence must be outside the checkout');
  const scope = scopeFiles(await git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', options.scope, options.head, '--']));
  // Git records are LF-delimited, not JavaScript multiline-regexp lines:
  // CR and Unicode line/paragraph separators may occur inside blob content.
  const starts = [...options.diff.matchAll(/(?:^|\n)diff --git /g)].map(match => match.index + (match[0].startsWith('\n') ? 1 : 0));
  const typeDiffs = new Map();
  if (starts.length !== scope.length) {
    // A type change can emit multiple patch blocks for one numstat record.
    // Ask Git for raw NUL-delimited paths, never decode its quoted headers.
    const changedTypes = await git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--diff-filter=T', '--name-only', '-z', options.scope, options.head, '--']);
    for (const filename of changedTypes.split('\0').filter(Boolean)) {
      typeDiffs.set(filename, await git(['-c', 'core.quotePath=false', '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', options.scope, options.head, '--', filename]));
    }
  }
  let byte = 0, position = 0, block = 0;
  const inventory = scope.map(file => {
    if (starts[block] !== position) throw new Error('Cannot index complete review scope');
    const typeDiff = typeDiffs.get(file.filename);
    let end;
    if (typeDiff !== undefined) {
      if (!typeDiff || !options.diff.startsWith(typeDiff, position)) throw new Error('Cannot index complete review scope');
      end = position + typeDiff.length;
      while (block < starts.length && starts[block] < end) block++;
      if (end !== (starts[block] ?? options.diff.length)) throw new Error('Cannot index complete review scope');
    } else {
      end = starts[++block] ?? options.diff.length;
    }
    const bytes = Buffer.byteLength(options.diff.slice(position, end));
    const entry = { ...file, scope: { start: byte, bytes } };
    byte += bytes;
    position = end;
    return entry;
  });
  if (position !== options.diff.length || block !== starts.length) throw new Error('Cannot index complete review scope');
  const records = JSON.parse(options.currentDiff);
  const chunks = ['[\n'];
  let patchBytes = 2;
  for (const [index, record] of records.entries()) {
    const text = JSON.stringify(record, null, 2);
    const entry = { filename: record.filename, ...(record.previous_filename === undefined ? {} : { previous_filename: record.previous_filename }), anchors: record.patch !== null, api: { start: patchBytes, bytes: Buffer.byteLength(text) } };
    inventory.push(entry);
    const chunk = text + (index === records.length - 1 ? '\n' : ',\n');
    chunks.push(chunk);
    patchBytes += Buffer.byteLength(chunk);
  }
  chunks.push(']\n');
  const patches = chunks.join('');
  const lines = inventory.map(entry => JSON.stringify(entry) + '\n');
  if (lines.some(line => Buffer.byteLength(line) > MAX_INVENTORY_RECORD)) throw new Error('Review inventory record exceeds bounded read budget; no scope was truncated');
  const index = lines.join('');
  await Promise.all([
    writeFile(join(directory, 'review-scope.diff'), options.diff, { mode: 0o400 }),
    writeFile(join(directory, 'pr-patches.json'), patches, { mode: 0o400 }),
    writeFile(join(directory, 'inventory.jsonl'), index, { mode: 0o400 }),
    writeFile(join(directory, 'read-evidence.mjs'), reader, { mode: 0o400 }),
  ]);
  const evidence = { directory, scopeFiles: scope.length, apiFiles: records.length, inventoryBytes: Buffer.byteLength(index), scopeBytes: byte, apiBytes: Buffer.byteLength(patches) };
  const input = prompt({ ...options, evidence });
  if (input.length > MAX_INLINE_INPUT) throw new Error('Navigable review prompt exceeds inline budget; no instructions or scope were truncated');
  return input;
}
