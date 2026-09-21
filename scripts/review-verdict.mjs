/** Versioned reviewer wire contract. Prose is evidence, never machine authority. */
import { createRequire } from 'node:module';
const { z } = await import(createRequire(new URL('../packages/core/package.json', import.meta.url)).resolve('zod'));
export const START = '<!-- agentrig-verdict:v1 -->';
export const END = '<!-- /agentrig-verdict -->';
const text = z.string().trim().min(1);
export const ReviewVerdict = z.object({
  version: z.literal(1),
  reviewedHead: z.string().regex(/^[0-9a-f]{40}$/, 'reviewedHead must be a full literal commit SHA'),
  assertedModel: text,
  modelSource: text,
  slot: text,
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(z.object({
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    // Do not normalize headings: the ledger quotes these exact bytes.
    heading: z.string().min(1).refine(v => v.trim().length > 0 && !/[\r\n]/.test(v)),
    location: z.string().regex(/^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$/, 'expected file:line'),
    blocking: z.boolean(),
    scenario: text,
  }).strict()),
}).strict().superRefine((v, ctx) => {
  if (v.verdict === 'PASS' && v.findings.some(f => f.blocking)) {
    ctx.addIssue({code: 'custom', path: ['verdict'], message: 'PASS cannot contain blocking findings'});
  }
  if (new Set(v.findings.map(f => f.heading)).size !== v.findings.length) {
    ctx.addIssue({code: 'custom', path: ['findings'], message: 'duplicate verbatim heading'});
  }
});
export function verdictBlock(value) { return `${START}\n${JSON.stringify(value, null, 2)}\n${END}`; }
export function hasVerdictBlock(body) { return body.includes('<!-- agentrig-verdict:') || body.includes(END); }
export function parseVerdict(body, expected = {}) {
  const starts = body.split(START);
  if (body.split('<!-- agentrig-verdict:').length !== 2 || starts.length !== 2 || body.split(END).length !== 2 || body.indexOf(END) < body.indexOf(START)) {
    throw new Error('expected exactly one complete agentrig-verdict:v1 block');
  }
  const verdict = ReviewVerdict.parse(JSON.parse(starts[1].split(END)[0].trim()));
  for (const key of ['reviewedHead', 'assertedModel', 'slot']) {
    if (expected[key] !== undefined && verdict[key] !== expected[key]) throw new Error(`verdict ${key} mismatch: expected ${expected[key]}`);
  }
  return verdict;
}
export function verdictPrompt({ reviewedHead, assertedModel, slot, modelSource }) {
  return `Preserve your human review prose. Include exactly one delimited JSON verdict block (not a code fence). Prose is not the verdict protocol; do not infer PASS from silence. Report your actual asserted model and its source; do not copy an expected model if it differs. Every finding has severity CRITICAL/HIGH/MEDIUM/LOW, exact verbatim heading, location file:line, boolean blocking, concrete failure scenario. PASS cannot include blocking findings. The following shape shows an empty PASS, not an instruction to pass:\n${verdictBlock({version:1, reviewedHead, assertedModel, modelSource, slot, verdict:'PASS', findings:[]})}`;
}
