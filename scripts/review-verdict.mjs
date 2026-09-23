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
  }).strip()),
}).strict().superRefine((v, ctx) => {
  if (v.verdict === 'PASS' && v.findings.some(f => f.blocking)) {
    ctx.addIssue({code: 'custom', path: ['verdict'], message: 'PASS cannot contain blocking findings'});
  }
  if (new Set(v.findings.map(f => f.heading)).size !== v.findings.length) {
    ctx.addIssue({code: 'custom', path: ['findings'], message: 'duplicate verbatim heading'});
  }
});
export function verdictBlock(value) { return `${START}\n${JSON.stringify(value, null, 2)}\n${END}`; }
// Only standalone, non-example delimiter lines participate in the protocol.
// Keep original offsets (including CRLF) for prose diagnostics and posting chunks.
function verdictMarkers(body) {
  const markers = [];
  let fence;
  for (const match of body.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0].replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; continue; }
    // A malformed standalone protocol delimiter is still an attempted block.
    // Prose substrings, code spans, blockquotes and indented code are not.
    if (/^ {0,3}<!-- \/?agentrig-verdict(?=[: >]|$)/.test(line)) {
      const text = line.trim();
      if (text.includes('-->') && text.indexOf('-->') !== text.length - 3) continue;
      markers.push({ text, start: match.index, end: match.index + match[0].length });
    }
  }
  return markers;
}
export function hasVerdictBlock(body) { return verdictMarkers(body).length > 0; }
export function verdictRange(body) {
  const markers = verdictMarkers(body);
  if (markers.length !== 2 || markers[0].text !== START || markers[1].text !== END) {
    throw new Error('expected exactly one complete agentrig-verdict:v1 block');
  }
  return { start: markers[0].start, contentStart: markers[0].end, contentEnd: markers[1].start, end: markers[1].end };
}
const findingKeys = new Set(['severity', 'heading', 'location', 'blocking', 'scenario']);
export function parseVerdictReceipt(body, expected = {}) {
  const range = verdictRange(body);
  const wire = JSON.parse(body.slice(range.contentStart, range.contentEnd).trim());
  const ignoredKeys = Array.isArray(wire?.findings) ? wire.findings.flatMap((finding, findingIndex) => {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) return [];
    const keys = Object.keys(finding).filter(key => !findingKeys.has(key)).sort();
    return keys.length ? [{ findingIndex, keys }] : [];
  }) : [];
  const verdict = ReviewVerdict.parse(wire);
  // A family assertion is not proof of a minor pin. Only adapter-owned transport is.
  const familyPin = /^gpt-(\d+)\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.exec(expected.assertedModel ?? "");
  const familyMatch = familyPin && verdict.assertedModel === `gpt-${familyPin[1]}`
    && expected.transportModel === expected.assertedModel;
  for (const key of ['reviewedHead', 'assertedModel', 'slot']) {
    if (key === 'assertedModel' && familyMatch) continue;
    if (expected[key] !== undefined && verdict[key] !== expected[key]) throw new Error(`verdict ${key} mismatch: expected ${expected[key]}`);
  }
  return { verdict, ignoredKeys };
}
export function parseVerdict(body, expected = {}) {
  return parseVerdictReceipt(body, expected).verdict;
}
export function verdictPrompt({ reviewedHead, assertedModel, slot, modelSource }) {
  const familyPin = /^gpt-(\d+)\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.exec(assertedModel ?? "");
  const assertionGuidance = familyPin
    ? `Assert the exact pin ${assertedModel} when known. If your identity only establishes the family, you may assert the major family gpt-${familyPin[1]}; it is accepted only with exact adapter transport proof of ${assertedModel}.`
    : `Assert the exact pin ${assertedModel ?? "(not supplied)"}; no family alias is accepted.`;
  return `Preserve your human review prose. Include exactly one delimited JSON verdict block (not a code fence). Prose is not the verdict protocol; do not infer PASS from silence. The adapter pins model ${assertedModel ?? "(not supplied)"}; its own transport provenance (${modelSource ?? "not supplied"}) must independently prove that exact pin before acceptance. ${assertionGuidance} If your own identity contradicts the configured pin, report that contradiction honestly. Never claim to have observed transport evidence yourself. Report the source of your assertion. Use this exact finding object shape once per finding, with no other keys: {"severity":"<CRITICAL|HIGH|MEDIUM|LOW>","heading":"<exact verbatim heading>","location":"<file:line>","blocking":"<true or false>","scenario":"<concrete failure scenario>"}. The \`blocking\` field is a boolean. PASS cannot include blocking findings. Required bindings: reviewedHead=${JSON.stringify(reviewedHead)}, slot=${JSON.stringify(slot)}. Expected model=${JSON.stringify(assertedModel)}; source guidance=${JSON.stringify(modelSource)}. Replace every placeholder below with your review result; the template is deliberately not a valid verdict:\n${verdictBlock({version:1, reviewedHead:'<full reviewed commit SHA>', assertedModel:'<actual model>', modelSource:'<actual source>', slot:'<review slot>', verdict:'<PASS or FAIL>', findings:'<array using the exact finding object shape above; [] only if no findings>'})}`;
}

/** Read only a trusted adapter-owned receipt; callers must not use reviewer-authored JSON. */
export function receiptTransport(receipt, expected, verdict, adapter) {
  if (receipt.exit !== 0 || receipt.reviewedHead !== expected.reviewedHead || receipt.slot !== expected.slot
    || receipt.model !== expected.assertedModel
    || (receipt.transportModel !== expected.assertedModel && !(receipt.adapter?.startsWith("api:") && receipt.transportModel === null))
    || receipt.assertedModel !== verdict.assertedModel || JSON.stringify(receipt.verdict) !== JSON.stringify(verdict)
    || (adapter !== undefined && receipt.adapter !== adapter)) throw new Error("adapter provenance binding mismatch");
  // Only CLI adapters currently obtain identity from an independent transport envelope.
  // API provider.model (including legacy receipts) is just the configured pin echoed back.
  return ["codex-cli", "claude-cli"].includes(receipt.adapter) ? receipt.transportModel : undefined;
}
