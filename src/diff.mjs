// GitHub accepts line ranges only within one diff hunk and one side.
export function parseDiff(diff) {
  const files = new Map();
  let file;
  let hunk;
  let left = 0;
  let right = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) { file = undefined; hunk = undefined; }
    if (text.startsWith('+++ ')) {
      const raw = text.slice(4);
      const path = raw === '/dev/null' ? file?.path : decodePath(raw).replace(/^b\//, '');
      if (path) { file = { path, hunks: [] }; files.set(path, file); }
      continue;
    }
    if (text.startsWith('--- ')) {
      const raw = text.slice(4);
      if (raw !== '/dev/null') file = { path: decodePath(raw).replace(/^a\//, ''), hunks: [] };
      continue;
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match && file) {
      left = Number(match[1]); right = Number(match[2]);
      hunk = { LEFT: new Set(), RIGHT: new Set() };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || text.startsWith('\\')) continue;
    if (text.startsWith('-')) hunk.LEFT.add(left++);
    else if (text.startsWith('+')) hunk.RIGHT.add(right++);
    else if (text.startsWith(' ')) { hunk.LEFT.add(left++); hunk.RIGHT.add(right++); }
  }
  return files;
}

function decodePath(raw) {
  if (!raw.startsWith('"')) return raw;
  // Git core.quotePath=false keeps Unicode literal; Git still quotes tabs/quotes.
  return JSON.parse(raw);
}

export function inlineComment(finding, files) {
  const { path, side, line, start_line: start } = finding;
  if (!['LEFT', 'RIGHT'].includes(side) || !Number.isInteger(line) || line < 1 || !Number.isInteger(start) || start < 1 || start > line) throw new Error('Invalid finding range');
  const file = files.get(path);
  const valid = file?.hunks.some(hunk => {
    for (let n = start; n <= line; n++) if (!hunk[side].has(n)) return false;
    return true;
  });
  if (!valid) throw new Error(`Finding is outside the current PR diff: ${path}:${start}-${line} ${side}`);
  return { path, side, line, ...(start !== line ? { start_line: start, start_side: side } : {}), body: `**[${finding.priority}] ${finding.title}**\n\n${finding.body}` };
}
