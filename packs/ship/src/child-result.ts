import { z } from "zod";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const path = z.string().min(1).max(1024).refine(value => !value.startsWith("/") &&
  !/[\\:*?\[\]\x00-\x1f]/u.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "use canonical repository-relative literal paths");
const evidence = z.object({ summary: z.string().trim().min(1).max(8192), paths: z.array(path).max(64) }).strict();
export const ChildResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pr"), pr: z.number().int().positive(), head: sha }).strict(),
  z.object({ status: z.literal("blocked"), kind: z.enum(["scope", "environment", "dependency", "ambiguity"]), evidence }).strict(),
]);
export type ChildResult = z.infer<typeof ChildResult>;

/** Transport envelope in core's existing bounded subset. The discriminated contract
 * and independent observations below are mandatory; schema success alone is not acceptance. */
export const childResultSchema = {
  type: "object", additionalProperties: false, required: ["status"], properties: {
    status: { type: "string", enum: ["pr", "blocked"] }, pr: { type: "integer", minimum: 1 },
    head: { type: "string", minLength: 40, maxLength: 64 },
    kind: { type: "string", enum: ["scope", "environment", "dependency", "ambiguity"] },
    evidence: { type: "object", additionalProperties: false, required: ["summary", "paths"], properties: {
      summary: { type: "string", minLength: 1, maxLength: 8192 },
      paths: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 1024 } },
    } },
  },
};
const Assessment = z.object({
  result: z.unknown(), attempt: z.union([z.literal(1), z.literal(2)]),
  previousNotes: z.array(z.string()), scope: z.array(path).min(1),
  observedPr: z.object({ pr: z.number().int().positive(), head: sha }).strict().optional(),
  verifiedBlocker: z.boolean().default(false), verifiedPaths: z.array(path).default([]),
}).strict();
export type ChildAssessment =
  | { action: "pr" | "blocked"; result: ChildResult; notes: string[] }
  | { action: "retry"; attempt: 2; notes: string[] }
  | { action: "halt"; notes: string[] };

/** Pure conductor aid, not a host retry loop. Observations must be gathered by the
 * conductor, never copied from the child. Scope is the authorized literal file/directory
 * list; verifiedPaths names paths independently found necessary to change. */
export function assessChildResult(input: unknown): ChildAssessment {
  const context = Assessment.parse(input); // Bad conductor state refuses, never resets the attempt.
  const parsed = ChildResult.safeParse(context.result);
  let failure: string | undefined;
  if (!parsed.success) failure = "Invalid typed child result";
  else if (parsed.data.status === "pr") {
    if (context.observedPr?.pr !== parsed.data.pr || context.observedPr.head !== parsed.data.head)
      failure = "PR/head not independently verified against the scoped repository and task";
  } else {
    if (!context.verifiedBlocker) failure = "Blocker necessity not independently verified";
    else if (parsed.data.kind === "scope" && !parsed.data.evidence.paths.some(candidate =>
      context.verifiedPaths.includes(candidate) && !context.scope.some(allowed => candidate === allowed || candidate.startsWith(`${allowed}/`))))
      failure = "Scope blocker needs at least one independently necessary outside-row path";
  }
  if (failure === undefined && parsed.success) return { action: parsed.data.status, result: parsed.data, notes: context.previousNotes };
  const notes = [...context.previousNotes, `${failure}: ${JSON.stringify(context.result) ?? "missing result"}`];
  return context.attempt === 1 ? { action: "retry", attempt: 2, notes } : { action: "halt", notes };
}
