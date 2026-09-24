import { expect, it } from "vitest";
import { createOutputContract } from "@agentkitai/agentrig-core";
import { ChildResult, childResultSchema, assessChildResult } from "../src/child-result.js";
import { shipTrainStages } from "../src/train.js";
const head = "a".repeat(40);
const pr = { status: "pr", pr: 7, head };
const blocked = { status: "blocked", kind: "scope", evidence: { summary: "Needs host change to satisfy contract", paths: ["packages/train/src/index.ts"] } };
const context = { attempt: 1, previousNotes: ["prior attempt notes"], scope: ["packages/core/src", "packs"], observedPr: { pr: 7, head }, verifiedPaths: ["packages/train/src/index.ts"], verifiedBlocker: true };
it("accepts complete independently observed PR and verified scope blocker", () => {
  expect(assessChildResult({ ...context, result: pr })).toMatchObject({ action: "pr", result: pr });
  expect(assessChildResult({ ...context, result: blocked })).toMatchObject({ action: "blocked", result: blocked });
});
it.each(["environment", "dependency", "ambiguity"])("accepts verified %s blockers", kind => {
  expect(assessChildResult({ ...context, result: { status: "blocked", kind, evidence: { summary: "independently confirmed blocker", paths: [] } } })).toMatchObject({ action: "blocked" });
});
it.each([{ status: "pr", pr: 7 }, { status: "blocked", kind: "scope" }, { status: "blocked", kind: "environment", evidence: { summary: "", paths: [] } }, { ...pr, extra: true }, "PR #7"])("rejects incomplete or free-text result %j", result => {
  expect(ChildResult.safeParse(result).success).toBe(false);
  expect(assessChildResult({ ...context, result })).toMatchObject({ action: "retry", attempt: 2 });
});
it("rejects claimed PR without independent matching head", () => {
  expect(assessChildResult({ ...context, observedPr: undefined, result: pr }).action).toBe("retry");
  expect(assessChildResult({ ...context, observedPr: { pr: 7, head: "b".repeat(40) }, result: pr }).action).toBe("retry");
});
it("rejects a scope blocker naming only an in-scope path or no path", () => {
  for (const paths of [["packages/core/src/agent.ts"], ["packs/ship/src/train.ts"], []]) {
    expect(assessChildResult({ ...context, verifiedPaths: paths, result: { ...blocked, evidence: { ...blocked.evidence, paths } } }).action).toBe("retry");
  }
});
it("does not treat an outside path as proof that changing it is necessary", () => {
  expect(assessChildResult({ ...context, verifiedPaths: [], result: blocked }).action).toBe("retry");
  expect(assessChildResult({ ...context, verifiedBlocker: false, result: blocked }).action).toBe("retry");
});
it.each(["../outside", "/tmp/outside", "packs/../outside", "packs\\outside"])("refuses noncanonical scope evidence %s", path => {
  expect(assessChildResult({ ...context, result: { ...blocked, evidence: { ...blocked.evidence, paths: [path] } }, verifiedPaths: [] }).action).toBe("retry");
});
it("one redispatch carries previous notes and the failed result; second failure halts", () => {
  const first = assessChildResult({ ...context, result: { status: "pr" } });
  expect(first).toMatchObject({ action: "retry", attempt: 2 });
  expect(first.notes).toContain("prior attempt notes");
  expect(first.notes.join("\n")).toContain('"status":"pr"');
  const second = assessChildResult({ ...context, attempt: 2, previousNotes: first.notes, result: {} });
  expect(second.action).toBe("halt");
  expect(second.notes.slice(0, first.notes.length)).toEqual(first.notes);
});
it("transport schema uses the bounded core subset; semantic validation rejects envelope-only answers", () => {
  const contract = createOutputContract(childResultSchema);
  expect(contract.validate(JSON.stringify(pr))).toBe("valid");
  expect(contract.validate(JSON.stringify(blocked))).toBe("valid");
  expect(contract.validate('{}')).not.toBe("valid");
  expect(assessChildResult({ ...context, result: { status: "pr" } }).action).toBe("retry");
});

it("refuses invalid conductor attempt state instead of silently resetting the retry", () => {
  expect(() => assessChildResult({ ...context, attempt: 3, result: pr })).toThrow();
});
it("rejects a non-full head SHA and accepts a directory-name sibling outside scope", () => {
  expect(assessChildResult({ ...context, result: { ...pr, head: "a".repeat(41) } }).action).toBe("retry");
  const outside = "packs-other/index.ts";
  expect(assessChildResult({ ...context, verifiedPaths: [outside], result: { ...blocked, evidence: { summary: "verified necessary sibling", paths: [outside] } } }).action).toBe("blocked");
});

it("keeps the final train receipt distinct from intermediate builder handoffs", () => {
  expect(shipTrainStages.receipt.parse({ pr: 7 })).toEqual({ pr: 7 });
  expect(() => shipTrainStages.receipt.parse(pr)).toThrow();
  expect(() => shipTrainStages.receipt.parse(blocked)).toThrow();
});
