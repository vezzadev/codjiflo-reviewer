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
  const blocks = [...options.diff.matchAll(/(?:^|\n)(diff --git [^\n]*)(?=\n|$)/g)].map(match => ({
    start: match.index + (match[0].startsWith('\n') ? 1 : 0),
    header: match[1],
  }));
  // Type changes (including regular-file/gitlink changes) emit deletion and
  // addition blocks with the exact same header. Renames have one distinct
  // header. Coalesce adjacent equal LF-delimited headers without parsing Git's
  // quoted paths or issuing a separate diff for each changed type.
  const groups = [];
  for (const block of blocks) {
    if (groups.at(-1)?.header !== block.header) groups.push(block);
  }
  if (groups.length !== scope.length) throw new Error('Cannot index complete review scope');
  let byte = 0, position = 0;
  const inventory = scope.map((file, index) => {
    if (groups[index].start !== position) throw new Error('Cannot index complete review scope');
    const end = groups[index + 1]?.start ?? options.diff.length;
    const bytes = Buffer.byteLength(options.diff.slice(position, end));
    const entry = { ...file, scope: { start: byte, bytes } };
    byte += bytes;
    position = end;
    return entry;
  });
  if (position !== options.diff.length || byte !== Buffer.byteLength(options.diff)) throw new Error('Cannot index complete review scope');
  const byFilename = new Map(inventory.map(entry => [entry.filename, entry]));
  const records = JSON.parse(options.currentDiff);
  const chunks = ['[\n'];
  let patchBytes = 2;
  for (const [index, record] of records.entries()) {
    const text = JSON.stringify(record, null, 2);
    const entry = byFilename.get(record.filename) ?? { filename: record.filename, ...(record.previous_filename === undefined ? {} : { previous_filename: record.previous_filename }) };
    entry.anchors = record.patch !== null;
    entry.api = { start: patchBytes, bytes: Buffer.byteLength(text) };
    if (!byFilename.has(record.filename)) inventory.push(entry);
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
