import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createAgent, SessionStore, RulePolicy, HarnessEvent, type EventPayload, type ModelEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { attach, TrajectoryReviewer } from "@agentkitai/agentrig-supervisor";
import { buildEvaluationReport, EvaluationManifest, formatEvaluationReport, readEvaluationReport, type EvaluationInput } from "../src/evaluation.js";

const runId = "00000000-0000-4000-8000-000000000001";
const events = (payloads: EventPayload[], sessionId = "main") => payloads.map((p, seq) => HarnessEvent.parse({ ...p, seq, ts: 100 + seq, sessionId }));
const start = { type: "session.start", task: "fixture", cwd: "/fixture", provider: "fixture", model: "one" } as const;
const response = { type: "model.response", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }, usageComplete: true, stop: "end_turn" } as const;
function fixture(): EvaluationInput {
  return {
    manifest: EvaluationManifest.parse({ version: 1, runId, task: "A1", evidenceLane: "scripted", evaluatorRevision: "a".repeat(40), startingRevision: "b".repeat(40),
      configuration: { supervisor: true, memory: false, memoryCorpusSha256: null, budgets: { maxTurns: 5, maxUsd: 1 }, roles: [
        { role: "main", provider: "fixture", model: "one", usdPerMillionTokens: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
        { role: "supervisor", provider: "fixture", model: "cheap", usdPerMillionTokens: { input: 0.5, output: 1 } },
        { role: "memory", provider: "fixture", model: "cheap", usdPerMillionTokens: { input: 1, output: 2 } },
        { role: "compaction", provider: "fixture", model: "cheap", usdPerMillionTokens: { input: 0.5, output: 1 } },
      ] }, logs: [{ path: "main.jsonl", sessionId: "main", role: "main" }], checks: "checks.json", auxiliary: "auxiliary.json",
      timing: { startedAt: 90, settledAt: 200, includesObserverAndMaintenance: true, evidence: "outer-clock.json" },
      coverage: { sessionLogsComplete: true, auxiliaryComplete: true, externalCostsUsd: 0, evidence: ["collector-receipt.json"] },
      changes: { independentlyChecked: true, unintended: [], evidence: "diff.txt" } }),
    checks: { task: "A1", runId, outcome: "PASS", behavior: "PASS", regression: "PASS", scope: "PASS", submittedTests: "PASS", manual: "NOT_REQUIRED", evidence: ["assertions passed"] },
    logs: [{ sessionId: "main", events: events([start, { type: "model.request", tokensIn: 99 }, response, { type: "session.end", reason: "done" }]) }],
    auxiliary: { snapshots: [], calls: [] },
  };
}
function auxiliary(final = true, input = 4, operation: "reviewer" | "ingest" = "reviewer") {
  return { sessionId: "main", id: "review-1", ts: 105, final, report: {
    operation, outcome: "completed" as const, durationMs: 3,
    calls: [{ operation: "completion", provider: "fixture", model: "cheap", outcome: "completed" as const, durationMs: 2, usage: { input, output: 2 }, usageComplete: true }],
    reportedUsage: { input, output: 2 }, unknownUsageCalls: 0, costUsd: null,
  } };
}
const temps: string[] = [];
async function temp() { const path = await realpath(await mkdtemp(join(tmpdir(), "agentrig-report-"))); temps.push(path); return path; }
afterEach(async () => { await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("E2 outcome and accounting", () => {
  it("prices disjoint token categories and preserves separate independent outcome/config/evidence", () => {
    const input = fixture(); const report = buildEvaluationReport(input);
    expect(report.main.reportedUsage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    expect(report.main.costUsd).toBeCloseTo(23.95 / 1_000_000, 12);
    expect(report.auxiliary.costUsd).toBe(0);
    expect(report.wallMs).toBe(110); expect(report.eventSpanMs).toBe(3);
    expect(report.configuration).toEqual(input.manifest.configuration);
    expect(report.outcome).toBe("PASS"); expect(report.agentEndReasons.main).toBe("done");
    expect(formatEvaluationReport(report)).toContain("independent checks");
    input.checks.behavior = "FAIL"; input.checks.outcome = "FAIL";
    expect(buildEvaluationReport(input).outcome).toBe("FAIL");
    expect(buildEvaluationReport(input).agentEndReasons.main).toBe("done");
  });

  it.each([undefined, false])("legacy/incomplete usage flag %s never makes a zero-response call free", (usageComplete) => {
    const input = fixture();
    input.logs[0]!.events = events([start, { type: "model.request", tokensIn: 99 },
      { type: "model.response", usage: { input: 0, output: 0 }, stop: "end_turn", ...(usageComplete === undefined ? {} : { usageComplete }) },
      { type: "session.end", reason: "done" }]);
    const report = buildEvaluationReport(input);
    expect(report.main.unknownUsageCalls).toBe(1); expect(report.main.costUsd).toBeNull(); expect(report.totalCostUsd).toBeNull();
    expect(formatEvaluationReport(report)).toContain("total cost: unknown");
  });

  it("a genuinely reported zero is distinct from missing usage", () => {
    const input = fixture(); input.logs[0]!.events[2] = HarnessEvent.parse({ ...input.logs[0]!.events[2], usage: { input: 0, output: 0 } });
    expect(buildEvaluationReport(input).main).toMatchObject({ unknownUsageCalls: 0, costUsd: 0 });
  });

  it("retries and unmatched requests remain explicit unknown calls", () => {
    const input = fixture(); input.logs[0]!.events = events([start, { type: "model.request", tokensIn: 1 },
      { type: "model.retry", attempt: 1, maxAttempts: 2, delayMs: 0, reason: "retry" }, { ...response, usageComplete: false },
      { type: "model.request", tokensIn: 1 }, { type: "session.end", reason: "aborted" }]);
    const report = buildEvaluationReport(input);
    expect(report.main).toMatchObject({ calls: 3, unknownUsageCalls: 3, costUsd: null });
    expect(report.main.reportedUsage.input).toBe(10);
  });

  it("replaces cumulative supervisor snapshots, including identical final receipts, rather than summing", () => {
    const input = fixture();
    input.logs[0]!.events = events([start, { type: "auxiliary.usage", ...auxiliary(false, 2), report: auxiliary(false, 2).report },
      { type: "model.request", tokensIn: 1 }, response, { type: "session.end", reason: "done" }]);
    input.auxiliary!.snapshots = [auxiliary(true, 4), { ...auxiliary(true, 4), ts: 110 }];
    const report = buildEvaluationReport(input);
    expect(report.auxiliary).toMatchObject({ calls: 1, unknownUsageCalls: 0, unfinishedRuns: 0, reportedUsage: { input: 4, output: 2 } });
    expect(report.auxiliary.costUsd).toBeCloseTo(4 / 1_000_000, 12);
    expect(report.main.reportedUsage.input).toBe(10);
  });

  it("unfinished reports and absent auxiliary collection never become zero spend", () => {
    const input = fixture(); input.auxiliary!.snapshots = [auxiliary(false)];
    expect(buildEvaluationReport(input).auxiliary).toMatchObject({ unknownUsageCalls: 1, unfinishedRuns: 1, costUsd: null });
    delete input.auxiliary;
    expect(buildEvaluationReport(input).auxiliary).toMatchObject({ coverageComplete: false, costUsd: null });
    expect(buildEvaluationReport(input).totalCostUsd).toBeNull();
  });

  it("a sidecar final supersedes same-millisecond provisional event snapshots", () => {
    const input = fixture(); input.logs[0]!.events = events([start,
      { type: "auxiliary.usage", id: "review-1", final: false, report: auxiliary(false, 2).report },
      { type: "session.end", reason: "done" }]);
    input.auxiliary!.snapshots = [{ ...auxiliary(), ts: 101 }];
    expect(buildEvaluationReport(input).auxiliary).toMatchObject({ calls: 1, unfinishedRuns: 0, reportedUsage: { input: 4 } });
  });

  it("includes memory and compaction receipts and separately attested backend costs", () => {
    const input = fixture(); const memory = auxiliary(true, 4, "ingest");
    input.manifest.configuration.memory = true; input.manifest.configuration.memoryCorpusSha256 = "c".repeat(64);
    input.auxiliary!.snapshots = [memory];
    input.auxiliary!.calls = [{ id: "compact-1", role: "compaction", call: { operation: "summary", provider: "fixture", model: "cheap",
      durationMs: 10, outcome: "completed", usageComplete: true, usage: { input: 7, output: 1 } } }];
    input.manifest.coverage.externalCostsUsd = 0.01;
    const report = buildEvaluationReport(input);
    expect(report.byRole.map((b) => b.role)).toEqual(["main", "memory", "compaction"]);
    expect(report.auxiliary.reportedUsage.input).toBe(11);
    expect(report.totalCostUsd).toBeCloseTo(0.01 + (23.95 + 8 + 4.5) / 1_000_000, 12);
  });

  it("does not invent missing cache prices, backend costs, model identity or observer settlement", () => {
    const input = fixture(); delete input.manifest.configuration.roles[0]!.usdPerMillionTokens!.cacheWrite;
    expect(buildEvaluationReport(input).main).toMatchObject({ unpricedCalls: 1, costUsd: null });
    input.manifest.coverage.externalCostsUsd = null;
    input.manifest.timing.includesObserverAndMaintenance = false;
    const aux = auxiliary(); delete (aux.report.calls[0] as { model?: string }).model; input.auxiliary!.snapshots = [aux];
    const report = buildEvaluationReport(input);
    expect(report.wallMs).toBeNull(); expect(report.totalCostUsd).toBeNull(); expect(report.auxiliary.costUsd).toBeNull();
    expect(report.warnings.join(" ")).toContain("unconfigured usage identity");
  });

  it("keeps a known check failure despite a contradictory human PASS; honors pending human review", () => {
    const input = fixture(); input.checks.manual = "PENDING"; input.checks.outcome = "BLOCKED";
    expect(buildEvaluationReport(input).outcome).toBe("BLOCKED");
    input.manifest.humanVerdict = { assessor: "operator", outcome: "PASS", reason: "rubric verified", evidence: "signed-verdict.txt" };
    expect(buildEvaluationReport(input).outcome).toBe("PASS");
    input.checks.outcome = "FAIL";
    expect(buildEvaluationReport(input).outcome).toBe("FAIL");
    input.checks.outcome = "PASS"; input.checks.behavior = "NOT_REQUIRED";
    expect(buildEvaluationReport(input).outcome).toBe("BLOCKED");
  });

  it("records only a declared pre-run SKIP without running/logged work", () => {
    const input = fixture(); input.checks.outcome = "SKIP";
    expect(() => buildEvaluationReport(input)).toThrow();
    input.logs = []; input.manifest.logs = []; input.checks.skipReason = "predeclared platform exclusion";
    expect(buildEvaluationReport(input).outcome).toBe("SKIP");
  });

  it("counts observable permission decisions, tool errors, interventions and retrieval requests without claiming recalled facts", () => {
    const input = fixture(); input.logs[0]!.events = events([start,
      { type: "permission.request", req: { tool: "memory_search", input: {}, class: "read", cwd: "/fixture" } },
      { type: "permission.decision", d: "allow" },
      { type: "tool.call", id: "one", name: "memory_search", input: {}, inputHash: "h" },
      { type: "tool.result", id: "one", ok: true, display: "no hits", durationMs: 1 },
      { type: "tool.call", id: "two", name: "memory_read", input: {}, inputHash: "h2" },
      { type: "tool.result", id: "two", ok: false, display: "missing", durationMs: 1 },
      { type: "tool.denied", id: "three", name: "bash" },
      { type: "permission.decision", d: "deny" },
      { type: "supervisor.intervention", intervention: { type: "force_replan" } },
      { type: "file.changed", path: "file.ts", op: "edit", contentHash: "x" },
      { type: "session.end", reason: "done" }]);
    const report = buildEvaluationReport(input);
    expect(report.permissions).toEqual({ requests: 1, allowDecisions: 1, denyDecisions: 1 });
    expect(report.retrievals).toEqual({ requests: 1, successfulToolResults: 1, pageReadRequests: 1 });
    expect(report.toolErrors).toBe(1); expect(report.toolDenials).toBe(1); expect(report.interventions.force_replan).toBe(1);
    expect(report.changes.eventReportedPaths).toEqual(["file.ts"]);
    input.manifest.changes.unintended = ["hidden-shell-write.txt"];
    expect(buildEvaluationReport(input).outcome).toBe("FAIL");
    input.manifest.changes.unintended = []; input.manifest.changes.independentlyChecked = false;
    expect(buildEvaluationReport(input).outcome).toBe("BLOCKED");
  });

  it("missing child logs or session.end make total coverage unknown; complete children are counted once", () => {
    const input = fixture(); input.logs[0]!.events = events([start, { type: "subagent.spawn", id: "child", task: "child task" }, { type: "session.end", reason: "done" }]);
    expect(buildEvaluationReport(input).main.costUsd).toBeNull();
    input.manifest.logs.push({ path: "child.jsonl", sessionId: "child", role: "subagent" });
    input.manifest.configuration.roles.push({ ...input.manifest.configuration.roles[0]!, role: "subagent" });
    input.logs.push({ sessionId: "child", events: events([{ ...start, parent: "main" }, { type: "model.request", tokensIn: 1 }, response, { type: "session.end", reason: "done" }], "child") });
    expect(buildEvaluationReport(input).main).toMatchObject({ calls: 1, unknownUsageCalls: 0, coverageComplete: true });
    input.logs[1]!.events.pop();
    expect(buildEvaluationReport(input).main.costUsd).toBeNull();
  });

  it("rejects inconsistent snapshots, IDs, configuration, order, duplicate results and mixed sessions", () => {
    const bad: Array<(input: EvaluationInput) => void> = [
      (i) => { i.checks.runId = "00000000-0000-4000-8000-000000000002"; },
      (i) => { i.manifest.configuration.roles[0]!.model = "wrong"; },
      (i) => { i.logs[0]!.events[1]!.seq += 1; },
      (i) => { i.logs[0]!.events[1]!.sessionId = "other"; },
      (i) => { i.logs[0]!.events.push({ ...i.logs[0]!.events[3]!, seq: 4 }); },
      (i) => { i.manifest.timing.settledAt = 99; },
      (i) => { const s = auxiliary(); s.report.reportedUsage.input++; i.auxiliary!.snapshots = [s]; },
      (i) => { i.auxiliary!.snapshots = [auxiliary(), { ...auxiliary(true, 9), ts: 110 }]; },
      (i) => { i.logs[0]!.events = events([start, { type: "tool.result", id: "unknown", ok: true, display: "x", durationMs: 0 }]); },
    ];
    for (const mutate of bad) { const input = fixture(); mutate(input); expect(() => buildEvaluationReport(input)).toThrow(); }
  });
});

describe("E2 actual provider and bundle integration", () => {
  it("reduces real observer snapshots and includes joined session-end maintenance in wall time", async () => {
    const path = await temp(); const releaseMain = Promise.withResolvers<void>(), reviewed = Promise.withResolvers<void>();
    let maintenanceFinished = 0;
    const main: ModelProvider = { id: "fixture", model: "one", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10000 },
      async *stream() { await releaseMain.promise; yield { type: "usage", usage: { input: 2, output: 3 } }; yield { type: "stop", reason: "end_turn" }; } };
    const reviewer: ModelProvider = { ...main, model: "cheap", async *stream() {
      yield { type: "text_delta", text: JSON.stringify({ diagnosis: "fixture", directions: [], guidance: "" }) };
      yield { type: "usage", usage: { input: 100, output: 20 } }; yield { type: "stop", reason: "end_turn" };
    } };
    const store = new SessionStore({ root: path, newId: () => "main" }); const startedAt = Date.now();
    const session = createAgent({ provider: main, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false,
      trustedProjectRoot: path, hooks: [{ point: "session_end", handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25)); maintenanceFinished = Date.now(); return { action: "continue" };
      } }] }).run("fixture", { cwd: path });
    const observer = attach(session, { detectors: [{ id: "once", observe: (event) => event.type === "session.start"
      ? { type: "loop", confidence: 1, evidence: ["fixture"], window: [0, 0] } : null }],
      policy: { decide: () => [{ type: "run_reviewer", reason: "fixture" }] },
      reviewer: new TrajectoryReviewer({ provider: reviewer }), onUsage: () => reviewed.resolve() });
    const timer = setTimeout(() => reviewed.reject(new Error("review fixture timed out")), 2000);
    try {
      await reviewed.promise; releaseMain.resolve(); await session.done; await observer.done;
      const settledAt = Date.now(); const recorded: HarnessEvent[] = []; for await (const e of store.read(session.id)) recorded.push(e);
      const input = fixture(); input.logs[0]!.events = recorded;
      input.manifest.timing = { startedAt, settledAt, includesObserverAndMaintenance: true, evidence: "actual joined fixture" };
      const report = buildEvaluationReport(input);
      expect(report.main.reportedUsage.input).toBe(2); expect(report.auxiliary.reportedUsage.input).toBe(100);
      expect(report.auxiliary.calls).toBe(1); expect(report.auxiliary.unknownUsageCalls).toBe(0);
      expect(report.wallMs).toBe(settledAt - startedAt); expect(maintenanceFinished).toBeGreaterThanOrEqual(startedAt + 20);
      expect(settledAt).toBeGreaterThanOrEqual(maintenanceFinished);
    } finally { clearTimeout(timer); releaseMain.resolve(); observer.detach(); session.control.abort(); await session.done; await observer.done; }
  });

  it("the published fixture remains a scripted FAIL despite an agent done event", async () => {
    const manifest = fileURLToPath(new URL("../../../eval/fixtures/report/manifest.json", import.meta.url));
    const report = await readEvaluationReport(manifest);
    expect(report).toMatchObject({ outcome: "FAIL", evidenceLane: "scripted", agentEndReasons: { "fixture-main": "done" }, wallMs: 110 });
    expect(report.totalCostUsd).toBeCloseTo(20 / 1_000_000, 12);
  });
  it.each(["reported", "missing", "synthetic", "retry", "unclosed"])("persists and reports %s usage from a real scripted session", async (kind) => {
    const path = await temp();
    const stream: ModelEvent[] = [];
    if (kind === "retry") stream.push({ type: "retry", attempt: 1, maxAttempts: 2, delayMs: 0, reason: "fixture" });
    if (kind !== "missing") stream.push({ type: "usage", usage: { input: 0, output: 0 }, ...(kind === "synthetic" ? { reported: false } : {}) });
    stream.push({ type: "text_delta", text: "done" });
    if (kind !== "unclosed") stream.push({ type: "stop", reason: "end_turn" });
    const provider: ModelProvider = { id: "fixture", model: "one", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10000 },
      async *stream() { yield* stream; } };
    const store = new SessionStore({ root: path, newId: () => "main" });
    const before = Date.now();
    const session = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false,
      compaction: { shouldCompact: () => false, compact: async (messages) => messages }, trustedProjectRoot: path }).run("fixture", { cwd: path });
    const observed: HarnessEvent[] = []; for await (const e of session.events) observed.push(e);
    await session.done;
    const input = fixture(); input.logs[0]!.events = observed;
    input.manifest.timing = { startedAt: before, settledAt: Date.now(), includesObserverAndMaintenance: true, evidence: "fixture-clock" };
    const response = observed.find((e) => e.type === "model.response");
    expect(response).toMatchObject({ usageComplete: kind === "reported" });
    const report = buildEvaluationReport(input);
    expect(report.main.costUsd).toBe(kind === "reported" ? 0 : null);
    expect(report.main.unknownUsageCalls).toBe(kind === "reported" ? 0 : kind === "retry" ? 2 : 1);
  });

  async function bundle() {
    const path = await temp(), input = fixture();
    await writeFile(join(path, "manifest.json"), JSON.stringify(input.manifest));
    await writeFile(join(path, "checks.json"), JSON.stringify(input.checks));
    await writeFile(join(path, "auxiliary.json"), JSON.stringify(input.auxiliary));
    await writeFile(join(path, "main.jsonl"), input.logs[0]!.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return { path, input, manifest: join(path, "manifest.json") };
  }
  it("loads bounded evidence, retains hashes, and renders through the built script", async () => {
    const b = await bundle(); const report = await readEvaluationReport(b.manifest);
    expect(Object.keys(report.evidence.sha256)).toHaveLength(4);
    expect(report.evidence.sha256["main.jsonl"]).toMatch(/^[a-f0-9]{64}$/);
    const script = fileURLToPath(new URL("../../../eval/report.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, b.manifest], { encoding: "utf8" });
    expect(JSON.parse(output).outcome).toBe("PASS");
    expect(execFileSync(process.execPath, [script, b.manifest, "--text"], { encoding: "utf8" })).toContain("Wall incl. observer/maintenance: 110 ms");
    b.input.checks.behavior = "FAIL"; b.input.checks.outcome = "FAIL";
    await writeFile(join(b.path, "checks.json"), JSON.stringify(b.input.checks));
    const failed = spawnSync(process.execPath, [script, b.manifest], { encoding: "utf8" });
    expect(failed.status).toBe(1); expect(JSON.parse(failed.stdout).outcome).toBe("FAIL");
  });
  it("rejects corrupt/truncated logs, unsafe paths and over-limit files without modifying them", async () => {
    const b = await bundle(); const log = join(b.path, "main.jsonl");
    for (const invalid of ['{"unfinished":', 'not json\n', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
      await writeFile(log, invalid); await expect(readEvaluationReport(b.manifest)).rejects.toThrow();
    }
    const outside = join(await temp(), "outside.json"); await writeFile(outside, JSON.stringify(b.input.checks));
    b.input.manifest.checks = relative(b.path, outside); await writeFile(b.manifest, JSON.stringify(b.input.manifest));
    await expect(readEvaluationReport(b.manifest)).rejects.toThrow("escapes its root");
    expect(await readFile(outside, "utf8")).toBe(JSON.stringify(b.input.checks));
  });

  it.skipIf(process.platform === "win32")("rejects a real FIFO input without waiting for a writer", async () => {
    const b = await bundle(); const fifo = join(b.path, "checks.fifo");
    execFileSync("mkfifo", [fifo]); b.input.manifest.checks = "checks.fifo";
    await writeFile(b.manifest, JSON.stringify(b.input.manifest));
    const script = fileURLToPath(new URL("../../../eval/report.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, b.manifest], { encoding: "utf8", timeout: 2000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).reason).toContain("regular files");
  });
});
