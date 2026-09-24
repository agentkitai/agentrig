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
it.each(["environment", "dependency", "ambiguity"])("rejects blanket verification for %s blockers", kind => {
  expect(assessChildResult({ ...context, result: { status: "blocked", kind, evidence: { summary: "independently confirmed blocker", paths: [] } } })).toMatchObject({ action: "retry" });
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

const claim = (kind: string, summary: string) => ({ status: "blocked", kind, evidence: { summary, paths: [] } });
const environment = { sessionId: "child-582", seq: 12, command: "pnpm build", exitCode: 1, output: "compiler missing" };
const event = { type: "tool.result", sessionId: "child-582", seq: 12, display: "compiler missing", commandOutcome: { command: "pnpm build", exitCode: 1 } };
const environmentSummary = JSON.stringify(environment);
const dependency = { repository: "agentkitai/agentrig", number: 600, kind: "pr" as const };
const dependencySummary = JSON.stringify(dependency);
const api = { repository: "agentkitai/agentrig", number: 600, kind: "pr", state: "open", merged_at: null };
const ambiguity = { sources: ["docs/PLAN.md#2.6", "docs/SHIPPING-WORKFLOW.md#typed"], question: "Which handoff contract takes precedence?" };
it("rejects the exact self-contradicting environment example from #582", () => {
  expect(assessChildResult({ ...context, result: claim("environment", "This builder run did not complete implementation. This is an incomplete execution, not a verified repository/environment blocker ...") }).action).toBe("retry");
});
it("matches environment citation against the child's own observed session event", () => {
  const input = { ...context, result: claim("environment", environmentSummary), childSessionId: "child-582", environment, sessionEvents: [event] };
  expect(assessChildResult(input).action).toBe("blocked");
  for (const delta of [{ sessionEvents: [] }, { childSessionId: "other" }, { sessionEvents: [{ ...event, sessionId: "other" }] }, { sessionEvents: [{ ...event, seq: 13 }] }, { environment: { ...environment, exitCode: 0 } }, { sessionEvents: [{ ...event, display: "success" }] }, { sessionEvents: [{ ...event, commandOutcome: { command: "other", exitCode: 1 } }] }, { sessionEvents: [{ ...event, commandOutcome: { command: "pnpm build", exitCode: 0 } }] }, { result: claim("environment", "unfinished execution") }])
    expect(assessChildResult({ ...input, ...delta }).action).toBe("retry");
});
it("rejects a correctly cited successful command from the child's own session", () => {
  const proof = { ...environment, exitCode: 0, output: "build completed" };
  const successEvent = { ...event, display: proof.output, commandOutcome: { command: proof.command, exitCode: proof.exitCode } };
  const input = { ...context, result: claim("environment", JSON.stringify(proof)), childSessionId: proof.sessionId, environment: proof, sessionEvents: [successEvent] };
  expect(assessChildResult(input)).toMatchObject({ action: "retry", attempt: 2 });
});
it("checks named dependency against independently fetched repository API state", () => {
  const input = { ...context, result: claim("dependency", dependencySummary), dependency, dependencyApi: api };
  expect(assessChildResult(input).action).toBe("blocked");
  for (const delta of [{ dependencyApi: undefined }, { dependencyApi: { ...api, merged_at: "2026-09-24" } }, { dependencyApi: { ...api, number: 601 } }, { dependencyApi: { ...api, repository: "other/repo" } }, { result: claim("dependency", "waiting") }])
    expect(assessChildResult({ ...input, ...delta }).action).toBe("retry");
  for (const kind of ["issue", "row"] as const) {
    const dep = { ...dependency, kind, ...(kind === "row" ? { row: "R19f" } : {}) };
    expect(assessChildResult({ ...input, dependency: dep, dependencyApi: { ...api, kind: "issue", ...(kind === "row" ? { row: "R19f" } : {}) }, result: claim("dependency", JSON.stringify(dep)) }).action).toBe("blocked");
    expect(assessChildResult({ ...input, dependency: dep, result: claim("dependency", JSON.stringify(dep)), dependencyApi: { ...api, state: "closed" } }).action).toBe("retry");
  }
});
it("routes verified conflicting sources and question to arbiter, never blocker halt", () => {
  const input = { ...context, result: claim("ambiguity", JSON.stringify(ambiguity)), ambiguity, verifiedSources: ambiguity.sources };
  expect(assessChildResult(input).action).toBe("arbiter");
  expect(assessChildResult({ ...input, attempt: 2 }).action).toBe("arbiter");
  for (const delta of [{ ambiguity: undefined }, { ambiguity: { ...ambiguity, question: "" } }, { verifiedSources: [] }, { ambiguity: { ...ambiguity, sources: [ambiguity.sources[0], ambiguity.sources[0]] } }, { result: claim("ambiguity", "unclear") }])
    expect(assessChildResult({ ...input, ...delta }).action).toBe("retry");
});
it.each(["environment", "dependency", "ambiguity"])("unverifiable %s preserves the one-retry rule", kind => {
  const first = assessChildResult({ ...context, result: claim(kind, "unfinished") });
  expect(first.action).toBe("retry");
  const second = assessChildResult({ ...context, result: claim(kind, "unfinished"), attempt: 2, previousNotes: first.notes });
  expect(second.action).toBe("halt");
  expect(second.notes.slice(0, first.notes.length)).toEqual(first.notes);
});
