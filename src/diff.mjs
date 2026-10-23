// GitHub accepts range endpoints only within one hunk and one side.
function parseHunks(patch) {
  const hunks = [];
  let hunk;
  let left = 0, right = 0, leftRemaining = 0, rightRemaining = 0;
  let additions = 0, deletions = 0;
  for (const text of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (match) {
      if (leftRemaining || rightRemaining) return null;
      left = Number(match[1]); right = Number(match[3]);
      leftRemaining = Number(match[2] ?? 1); rightRemaining = Number(match[4] ?? 1);
      hunk = { LEFT: new Set(), RIGHT: new Set() };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || text.startsWith('\\') || text === '') continue;
    if (text.startsWith('-')) { hunk.LEFT.add(left++); leftRemaining--; deletions++; }
    else if (text.startsWith('+')) { hunk.RIGHT.add(right++); rightRemaining--; additions++; }
    else if (text.startsWith(' ')) { left++; leftRemaining--; hunk.RIGHT.add(right++); rightRemaining--; }
    else return null;
    if (leftRemaining < 0 || rightRemaining < 0) return null;
  }
  return leftRemaining || rightRemaining ? null : { hunks, additions, deletions };
}

// API filenames are already decoded and always identify the current path, even
// for renames. Missing or incomplete patches deliberately expose no anchors.
export function filesFromApi(metadata) {
  return new Map(metadata.map(file => {
    const parsed = typeof file.patch === 'string' ? parseHunks(file.patch) : null;
    const complete = parsed && parsed.additions === file.additions && parsed.deletions === file.deletions;
    return [file.filename, { path: file.filename, previousPath: file.previous_filename, hunks: complete ? parsed.hunks : [], patch: complete ? file.patch : null }];
  }));
}

export function inlineComment(finding, files) {
  const { path, side, line, start_line: start } = finding;
  if (!['LEFT', 'RIGHT'].includes(side) || !Number.isInteger(line) || line < 1 || !Number.isInteger(start) || start < 1 || start > line) throw new Error('Invalid finding range');
  const file = files.get(path);
  const valid = file?.hunks.some(hunk => hunk[side].has(start) && hunk[side].has(line));
  if (!valid) throw new Error(`Finding is outside the current PR diff: ${path}:${start}-${line} ${side}`);
  return { path, side, line, ...(start !== line ? { start_line: start, start_side: side } : {}), body: `**[${finding.priority}] ${finding.title}**\n\n${finding.body}` };
}
