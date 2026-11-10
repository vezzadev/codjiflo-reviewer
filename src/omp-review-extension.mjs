export const REVIEW_TOOLS = ['read', 'grep', 'glob', 'find', 'bash', 'final_review'];

export default function reviewExtension(pi) {
  const z = pi.zod;
  let submitted = false;
  const activate = async () => { await pi.setActiveTools(REVIEW_TOOLS); };
  pi.on('session_start', activate);
  pi.on('before_agent_start', activate);
  pi.on('tool_call', event => {
    if (!REVIEW_TOOLS.includes(event.toolName)) {
      return { block: true, reason: 'Only source-inspection tools and final_review are permitted in a review.' };
    }
  });
  pi.registerTool({
    name: 'final_review',
    label: 'Submit final review',
    description: 'Submit the completed review exactly once. Use INCOMPLETE only for an actual unrecoverable analysis blocker. After this tool succeeds, end with a short acknowledgement and no more tools.',
    parameters: z.object({
      verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE']),
      summary: z.string(),
      resolutions: z.array(z.object({
        id: z.string(), status: z.enum(['resolved', 'unresolved']), reason: z.string().min(1),
      }).strict()),
      findings: z.array(z.object({
        path: z.string(), side: z.enum(['LEFT', 'RIGHT']),
        start_line: z.number().int().min(1), line: z.number().int().min(1),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']),
        disposition: z.enum(['blocking', 'advisory']),
        title: z.string(), body: z.string(),
      }).strict()),
    }).strict(),
    async execute() {
      if (submitted) throw new Error('final_review may only be submitted once');
      submitted = true;
      return { content: [{ type: 'text', text: 'Review captured. End now with a short acknowledgement.' }], details: { accepted: true } };
    },
  });
  // A terminal provider failure (unavailable model, exhausted quota) cannot be
  // fixed by continuing: refusing the stop would repeat the failed request until
  // the time limit instead of letting OMP exit unsuccessfully with its error.
  let providerFailed = false;
  pi.on('message_end', event => {
    if (event?.message?.role === 'assistant') providerFailed = event.message.stopReason === 'error';
  });
  pi.on('session_stop', () => {
    if (!submitted && !providerFailed) return { decision: 'block', reason: 'Submit your review using final_review before ending. Continue required analysis while evidence and tools remain available.' };
  });
}
