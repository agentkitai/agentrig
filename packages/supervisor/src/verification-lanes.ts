import { z } from "zod";

const text = z.string().min(1).max(512);
export const VerificationLane = z.object({
  verdict: z.enum(["PASS", "FAIL", "BLOCKED", "SKIP"]),
  complete: z.boolean(),
  basis: z.enum(["pinned-regression", "surface", "golden", "second-method", "same-assumption", "unknown"]),
  references: z.array(text).max(8),
  observation: text.optional(),
  negativeProbe: text.optional(),
  exclusion: z.object({ beforeRun: z.literal(true), reason: text }).strict().optional(),
}).strict();

/** Evaluator-owned input, NOT an authenticated receipt or a model-facing tool schema. */
export const VerificationEvidence = z.object({
  task: text,
  runId: z.string().uuid(),
  evaluator: z.object({ id: text, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  regression: VerificationLane,
  behavior: VerificationLane.extend({ humanReview: z.literal("required").optional() }),
  /** Optional trusted host assessment of the explicitly designated prose component only. */
  humanAssessment: z.object({ assessor: z.string().min(1).max(4096), outcome: z.enum(["PASS", "FAIL"]),
    reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096) }).strict().optional(),
}).strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;
export type VerificationVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

/** Shared E2/M6 reduction. Trust comes from the caller's evaluator custody, never these labels. */
export function assessVerificationLanes(input?: VerificationEvidence) {
  const parsed = VerificationEvidence.safeParse(input);
  if (!parsed.success) return { verdict: "BLOCKED" as VerificationVerdict,
    text: "Verification lanes: BLOCKED — absent/invalid evaluator evidence; independence unverified.",
    gaps: ["verification lanes: absent/invalid evaluator evidence; independence unverified"] };
  const evidence = parsed.data;
  const gaps: string[] = [];
  const lines = [`Verification lanes for ${JSON.stringify(evidence.task)} / ${evidence.runId}`,
    `Provenance: evaluator-attested ${JSON.stringify(evidence.evaluator.id)} (${evidence.evaluator.sourceSha256}); not semantic proof or authenticated independence.`];
  const verdicts = (["regression", "behavior"] as const).map(name => {
    const lane = evidence[name];
    let verdict = lane.verdict;
    let reason = "evaluator-observed checks passed; scope limited to cited probes";
    if (verdict === "FAIL") reason = "observed failure; partial success does not erase it";
    else if (verdict === "SKIP") {
      if (lane.exclusion === undefined || lane.complete || lane.observation !== undefined || lane.negativeProbe !== undefined) {
        verdict = "BLOCKED"; reason = "SKIP requires a pre-run exclusion with no observed attempt";
      } else reason = `pre-run exclusion: ${JSON.stringify(lane.exclusion.reason)}`;
    } else if (verdict === "BLOCKED" || !lane.complete || lane.references.length === 0 || lane.observation === undefined) {
      verdict = "BLOCKED"; reason = "missing/partial observation or references";
    } else if (lane.basis === "unknown" || lane.basis === "same-assumption") {
      verdict = "BLOCKED"; reason = "oracle unknown or shares the implementation assumption; discounted";
    } else if (name === "behavior" && evidence.behavior.humanReview === "required") {
      // A4/X4's existing human gate supplements complete structural/golden answer checks.
      // It does not claim an automated adversarial probe or waive any preceding deficit.
      if (lane.basis !== "golden" || evidence.humanAssessment === undefined) {
        verdict = "BLOCKED"; reason = "structured answer checks do not establish semantics; human assessment required";
      } else {
        verdict = evidence.humanAssessment.outcome;
        reason = `structured answer checks passed; semantic component: human ${verdict} by ${JSON.stringify(evidence.humanAssessment.assessor)}; no automatic behavior probe claimed`;
      }
    } else if (name === "behavior" && (lane.basis === "pinned-regression" || lane.negativeProbe === undefined)) {
      verdict = "BLOCKED"; reason = "behavior needs its own surface/oracle observation and negative/adversarial probe";
    }
    if (verdict !== "PASS") gaps.push(`${name}: ${verdict} — ${reason}`);
    lines.push(`${name}: ${verdict} — ${reason}; basis=${lane.basis}; refs=${JSON.stringify(lane.references)}`,
      `  observation=${JSON.stringify(lane.observation ?? "unverified")}; negative probe=${JSON.stringify(lane.negativeProbe ?? "unverified")}`);
    return verdict;
  });
  if (evidence.behavior.humanReview === "required") lines.push(`Human semantic assessment: ${JSON.stringify(evidence.humanAssessment ?? "pending/unverified")}`);
  const verdict: VerificationVerdict = verdicts.includes("FAIL") ? "FAIL" : verdicts.every(v => v === "SKIP") ? "SKIP" :
    verdicts.every(v => v === "PASS") ? "PASS" : "BLOCKED";
  lines.push(`Combined: ${verdict}; no partial pass. Matching evaluator checks never force the model grader to pass.`);
  return { verdict, text: lines.join("\n"), gaps };
}
