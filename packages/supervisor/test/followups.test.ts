import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { contentHash, HarnessEvent, type EventPayload, type Session } from "@agentkitai/agentrig-core";
import { attach, driftDetector, initialState, inScope, loopDetector, reduce, type GradeInput } from "@agentkitai/agentrig-supervisor";
import * as stateModule from "../src/state.js";
import { evidenceReportCollector } from "../src/evidence-report.js";
import { assessVerificationLanes } from "../src/verification-lanes.js";
import { AuxiliaryRun } from "../src/auxiliary.js";

afterEach(() => vi.restoreAllMocks());
function events() { let seq = 0; return (p: EventPayload) => HarnessEvent.parse({ ...p, seq: seq++, ts: 1, sessionId: "fixture" }); }

it("normalizes absolute scope within cwd without accepting sibling or escaped paths", () => {
  expect(inScope("src/a.ts", ["/repo/src"], "/repo")).toBe(true);
  expect(inScope("/repo/src/a.ts", ["src"], "/repo")).toBe(true);
  expect(inScope("src/a.ts", ["/elsewhere/src"], "/repo")).toBe(false);
  for (const scope of ["", ".", "/", "./"]) {
    expect(inScope("src/a.ts", [scope], "/repo")).toBe(true);
    expect(inScope("../elsewhere/a", [scope], "/repo")).toBe(false);
  }
  expect(inScope("../elsewhere/a", ["."], "/repo")).toBe(false);
  expect(inScope("src/a.ts", ["../repo-neighbor/src"], "/repo")).toBe(false);
  expect(inScope("src/a.ts", ["C:\\repo\\src"], "C:\\repo")).toBe(true);
  expect(inScope("D:\\repo\\src\\a.ts", ["."], "C:\\repo")).toBe(false);
});

it("destructured drift and loop observe handle a real corroborated result and absolute plan", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-followup-drift-"));
  try {
    await writeFile(join(cwd, "actual.txt"), "written");
    for (const scope of [[join(cwd, "actual.txt")], [join(await realpath(cwd), "actual.txt")], ["other.txt"]]) {
      const ev = events(); const state = initialState();
      const drift = driftDetector({ scope, contract: [] }); const loop = loopDetector();
      const observeDrift = drift.observe; const observeLoop = loop.observe;
      const call = ev({ type: "tool.call", id: "write", name: "write_file", input: {}, inputHash: "h" });
      const change = ev({ type: "file.changed", path: "actual.txt", op: "edit", contentHash: contentHash("written"), toolCallSeq: call.seq });
      const result = ev({ type: "tool.result", id: "write", toolCallSeq: call.seq, permission: "write", ok: true, display: "written", durationMs: 0 });
      state.cwd = cwd;
      for (const e of [call, change]) reduce(state, e);
      reduce(state, result); await drift.prepare!(result, state, new AbortController().signal);
      expect(observeLoop(result, state)).toBeNull();
      expect(observeDrift(result, state)?.type ?? null).toBe(scope[0] === "other.txt" ? "drift" : null);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it.each(["tool.denied", "tool.result"] as const)("releases failed pending writes on %s before a late result", type => {
  const ev = events(); const state = initialState();
  const call = ev({ type: "tool.call", id: "write", name: "write_file", input: {}, inputHash: "h" });
  const change = ev({ type: "file.changed", path: "actual.txt", op: "edit", contentHash: "0".repeat(16), toolCallSeq: call.seq });
  const failure = type === "tool.denied" ? ev({ type, id: "write", name: "write_file" }) :
    ev({ type, id: "write", ok: false, display: "failed", durationMs: 0 });
  for (const e of [call, change, failure, ev({ type: "tool.result", id: "write", toolCallSeq: call.seq,
    permission: "write", ok: true, display: "late", durationMs: 0 })]) reduce(state, e);
  expect(state.filesChanged).toBe(0);
});

it("collector retains later useful plans after a corrupt fold and stays incomplete", () => {
  const ev = events(); const collector = evidenceReportCollector();
  collector.observe(ev({ type: "session.start", id: "fixture", task: "task", cwd: "/repo", provider: "fake", model: "fake" }));
  const bad = { ...ev({ type: "plan.updated", items: [] }), items: null } as unknown as HarnessEvent;
  expect(() => collector.observe(bad)).not.toThrow();
  collector.observe(ev({ type: "plan.updated", items: [{ id: "later", text: "useful", status: "done", accept: "false exits 0" }] }));
  expect(collector.report()).toMatchObject({ incomplete: true, finished: false, hasDeclarations: true });
  expect(collector.report().text).toContain("later");
});

it("actual attach independently observes evidence when the shared state fold throws", async () => {
  const ev = events(); const original = stateModule.reduce;
  vi.spyOn(stateModule, "reduce").mockImplementation((state, event, opts) => {
    if (event.type === "plan.updated") throw new Error("controlled state fold failure");
    original(state, event, opts);
  });
  const recorded: unknown[] = []; const errors: string[] = []; let supplied: GradeInput | undefined;
  const session = { id: "fixture", done: new Promise(() => {}),
    events: (async function* () {
      yield ev({ type: "session.start", id: "fixture", task: "task", cwd: "/repo", provider: "fake", model: "fake" });
      yield ev({ type: "plan.updated", items: [{ id: "lost-before", text: "must remain visible", status: "done", accept: "false exits 0" }] });
      yield ev({ type: "model.delta", text: "grade" });
    })(), control: { record: (value: unknown) => recorded.push(value), steer() {}, abort() {} } } as unknown as Session;
  const observer = attach(session, { detectors: [{ id: "trigger", observe: event => event.type === "model.delta" ?
    { type: "stall", confidence: 1, evidence: ["trigger"], window: [event.seq, event.seq] } : null }],
    policy: { decide: () => [{ type: "run_grader", rubric: "verify" }] },
    grader: { async grade(input) { supplied = input; return { pass: false, gaps: ["unverified"] }; } },
    onError: (where) => { errors.push(where); } });
  try { await observer.done; } finally { observer.detach(); }
  expect(errors).toContain("state"); expect(supplied?.evidence?.incomplete).toBe(true);
  expect(supplied?.evidence?.text).toContain("lost-before");
  const snapshots = recorded.filter((value): value is Extract<HarnessEvent, { type: "auxiliary.usage" }> =>
    (value as { type?: string }).type === "auxiliary.usage");
  expect(snapshots.find(value => !value.final)?.report.calls[0]).toMatchObject({ state: "running", usageComplete: false });
  expect(snapshots.find(value => value.final)?.report.calls[0]).toMatchObject({ state: "settled", outcome: "completed", usageComplete: false });
});

it("shows original attestations separately when derived lane is blocked", () => {
  const lane = { verdict: "PASS", complete: true, basis: "same-assumption", references: ["check"], observation: "reported pass" } as const;
  const report = assessVerificationLanes({ task: "task", runId: "00000000-0000-4000-8000-000000000000",
    evaluator: { id: "host", sourceSha256: "0".repeat(64) }, regression: { ...lane, references: ["check"] }, behavior: { ...lane, references: ["check"] } });
  expect(report.verdict).toBe("BLOCKED");
  expect(report.text).toContain("original attestation: PASS; complete=true");
  expect(report.text).toContain("regression: BLOCKED");
});

it.each([false, true])("auxiliary provisional calls are neutral and settle without changing terminal semantics (failed=%s)", async failed => {
  const run = new AuxiliaryRun("reviewer"); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = run.call("review", "fake", async () => { await gate; if (failed) throw new Error("fixture failure"); });
  let final: ReturnType<AuxiliaryRun["finish"]> | undefined;
  try { expect(run.snapshot().calls[0]).toMatchObject({ state: "running", usageComplete: false }); }
  finally { release(); await work.catch(() => {}); final = run.finish(); }
  expect(final.calls[0]).toMatchObject({ state: "settled", outcome: failed ? "failed" : "completed", usageComplete: false });
});
