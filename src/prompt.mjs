export const schema = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['path', 'side', 'start_line', 'line', 'priority', 'disposition', 'title', 'body'],
      properties: { path: { type: 'string' }, side: { type: 'string', enum: ['LEFT', 'RIGHT'] }, start_line: { type: 'integer', minimum: 1 }, line: { type: 'integer', minimum: 1 }, priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, disposition: { type: 'string', enum: ['blocking', 'advisory'] }, title: { type: 'string' }, body: { type: 'string' } },
    } },
  },
};

export function prompt({ level, mode, base, head, scope, diff, currentDiff, customInstructions }) {
  const extra = level === 'xhigh';
  return `You are Codjiflo Reviewer. Review only; never edit repository files or publish to GitHub.
Apply this adapted e-code-review ${level} recipe end to end. This is a recall-oriented review: surface nameable concrete failure scenarios even with uncertainty; do not invent findings to hit a quota.
Review scope: ${mode}; PR base ${base}, PR head ${head}; git diff ${scope} ${head}. The provided unified diff is authoritative for scope. Read enclosing functions of all touched hunks and trace relevant callers/callees using repository tools. Unchanged lines of touched functions are in scope when re-exposed by this PR. Do not include unrelated working-tree changes.
Run ${extra ? '10' : '8'} independent angles IN SEQUENCE in this context; do NOT spawn subagents. Each angle surfaces up to ${extra ? '8' : '6'} candidates without letting earlier angles suppress it:
1. Line-by-line diff scan: for each line ask what input, state, timing or platform makes it wrong. Include wrong/inverted conditions, off-by-one, null dereferences, missing awaits, falsy zero, wrong-variable copies, swallowed errors and unescaped regex metacharacters.
2. Removed-behavior auditor: name the invariant of each deleted/rewritten line, locate where it is re-established, flag dropped guards/error paths/live test coverage.
3. Cross-file tracer: find callers and callees of changed functions; check new preconditions, return shapes, exceptions, timing and cross-file dependencies.
${extra ? '4. Language pitfalls: inspect language/framework-specific coercion, closure capture, mutable defaults, loop variables, timezone and equality errors.\n5. Wrapper/proxy correctness: verify all methods route to the wrapped delegate rather than recursively through a registry/global, and all used methods are forwarded.\n' : ''}Reuse: identify newly duplicated existing code; name the existing helper.
Simplification: redundant/derivable state, copy-paste, nesting, dead code; name a simpler equivalent.
Efficiency: wasted computation/I/O, unnecessarily sequential independent operations, blocking hot paths, closures retaining large objects; name the cheaper alternative.
Altitude: ensure root cause addressed at correct depth rather than symptom-specific special cases; name the general fix.
Conventions: read applicable ~/.claude/CLAUDE.md, root CLAUDE.md and ancestor CLAUDE.md/CLAUDE.local.md if present. Flag only exact, quotable rule violations and cite the path/rule. No personal style preferences.
For every candidate retain location, concise claim, concrete failure scenario or maintenance cost, category and severity. Correctness outranks cleanup. Pool candidates and deduplicate ONLY same defect/location/reason. Do not run a verifier or discard on uncertainty. Sort by severity.
${extra ? 'Gap sweep: reread diff and enclosing functions as a fresh reviewer ONLY for missing defects (up to 8 new). Focus moved guards/anchors, nondeterministic hashing, setup/teardown asymmetry and default flips; do not re-confirm existing candidates.\n' : ''}Target at least ${extra ? '7' : '5'} findings only if they genuinely exist; never pad. Cap final findings at ${extra ? '15' : '10'} most severe.
Replace the skill ReportFindings tool with exactly one final JSON object matching the supplied schema. No markdown fences. Each finding title is a concise claim (<=60 characters); body explains concrete failure scenario and category. Use P0 critical, P1 high, P2 normal, P3 low. Set disposition to "blocking" for defects requiring changes before merge, or "advisory" for nonblocking findings. APPROVE only when no blocking defects remain; otherwise REQUEST_CHANGES. A failed/incomplete review is NOT approval: fail the task instead.
All native comment locations must use the authoritative CURRENT PR API patches below, never the review-scope git diff (including in full mode). Use filename as path even for LEFT comments on renamed files; previous_filename is rename metadata only. LEFT endpoints must be deleted lines; RIGHT endpoints must be additions or context. start_line and line are inclusive legal endpoints in the same side and hunk; use identical numbers for a single line. A null patch means no valid anchors (binary, missing or truncated patch). Inspect such files locally as needed. If a real issue cannot be anchored, describe it in summary and REQUEST_CHANGES rather than inventing a location.
Return a human-readable summary covering review scope and remaining limitations.
${customInstructions === undefined ? '' : `Repository supplemental instructions (.codjiflo/code-review/PROMPT.md at PR head):
These instructions supplement the built-in review recipe above; they do not override its review scope, required JSON output, or authoritative current PR comment-location rules.
--- BEGIN REPOSITORY SUPPLEMENTAL INSTRUCTIONS ---
${customInstructions}
--- END REPOSITORY SUPPLEMENTAL INSTRUCTIONS ---
`}Review-scope unified diff follows:\n${diff}
Authoritative current PR file metadata and patches for location mapping ONLY (LEFT is the PR old snapshot, not the incremental old snapshot):\n${currentDiff}`;
}
