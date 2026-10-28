import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { prompt } from './prompt.mjs';
import { MAX_INLINE_INPUT, MAX_EVIDENCE_READ_BYTES } from './input-budget.mjs';

// Generated names only: repository paths are JSON data, never staging paths or
// shell syntax. The helper is trusted runner code, not executable PR content.
const reader = `import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [name, startText = '0', sizeText = '${MAX_EVIDENCE_READ_BYTES}'] = process.argv.slice(2);
if (!['inventory.jsonl', 'review-scope.diff', 'pr-patches.json'].includes(name)) throw new Error('Unknown evidence file');
const start = Number(startText), size = Number(sizeText);
if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > ${MAX_EVIDENCE_READ_BYTES}) throw new Error('Invalid byte range (maximum ${MAX_EVIDENCE_READ_BYTES})');
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
  const fromCheckout = relative(checkout, parent);
  if (fromCheckout === '' || (!fromCheckout.startsWith('..' + sep) && fromCheckout !== '..' && !isAbsolute(fromCheckout))) throw new Error('Review evidence must be outside the checkout');
  const directory = await mkdtemp(join(parent, 'review-evidence-'));
  const scope = scopeFiles(await git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', options.scope, options.head, '--']));
  // Git records are LF-delimited, not JavaScript multiline-regexp lines:
  // CR and Unicode line/paragraph separators may occur inside blob content.
  const blocks = [...options.diff.matchAll(/(?:^|\n)(diff --git [^\n]*)(?=\n|$)/g)].map(match => ({
    start: match.index + (match[0].startsWith('\n') ? 1 : 0),
    header: match[1],
    mode: options.diff.slice(match.index + match[0].length + 1, match.index + match[0].length + 33).match(/^(deleted|new) file mode ([0-7]{6})\n/),
  }));
  // Only proven delete/add type-change pairs share one numstat record.
  // Rename headers can collide for distinct paths containing " b/"; their
  // text is not an unambiguous path encoding and must never be decoded.
  const groups = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], next = blocks[index + 1];
    groups.push(block);
    if (block.header === next?.header && block.mode?.[1] === 'deleted' &&
        next.mode?.[1] === 'new' && block.mode[2].slice(0, 3) !== next.mode[2].slice(0, 3)) index++;
  }
  if (groups.length !== scope.length || (groups[0]?.start ?? 0) !== 0 || (!groups.length && options.diff.length)) throw new Error('Cannot index complete review scope');
  let byte = 0;
  const inventory = scope.map((file, index) => {
    const end = groups[index + 1]?.start ?? options.diff.length;
    const bytes = Buffer.byteLength(options.diff.slice(groups[index].start, end));
    const entry = { ...file, scope: { start: byte, bytes } };
    byte += bytes;
    return entry;
  });
  const byFilename = new Map(inventory.map(entry => [entry.filename, entry]));
  const records = JSON.parse(options.currentDiff);
  const chunks = ['[\n'];
  let patchBytes = 2;
  const apiByPath = new Map();
  for (const [index, record] of records.entries()) {
    const text = JSON.stringify(record, null, 2);
    const entry = byFilename.get(record.filename) ?? { filename: record.filename, ...(record.previous_filename === undefined ? {} : { previous_filename: record.previous_filename }) };
    entry.anchors = record.patch !== null ? 'inline' : 'none';
    entry.api = { start: patchBytes, bytes: Buffer.byteLength(text) };
    const candidate = { filename: record.filename, ...(record.previous_filename === undefined ? {} : { previous_filename: record.previous_filename }), api: entry.api, anchors: entry.anchors };
    for (const path of new Set([record.filename, record.previous_filename].filter(path => path !== undefined))) {
      if (!apiByPath.has(path)) apiByPath.set(path, []);
      apiByPath.get(path).push(candidate);
    }
    if (!byFilename.has(record.filename)) inventory.push(entry);
    const chunk = text + (index === records.length - 1 ? '\n' : ',\n');
    chunks.push(chunk);
    patchBytes += Buffer.byteLength(chunk);
  }
  chunks.push(']\n');
  for (const entry of inventory.filter(entry => entry.scope)) {
    const related = new Set([...(apiByPath.get(entry.filename) ?? []), ...(apiByPath.get(entry.previous_filename) ?? [])]);
    entry.apiRelated = [...related].filter(candidate => candidate.filename !== entry.filename);
    if (!entry.apiRelated.length) delete entry.apiRelated;
  }
  const patches = chunks.join('');
  const lines = inventory.map(entry => JSON.stringify(entry) + '\n');
  if (lines.some(line => Buffer.byteLength(line) > MAX_EVIDENCE_READ_BYTES)) throw new Error('Review inventory record exceeds bounded read budget; no scope was truncated');
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
