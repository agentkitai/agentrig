import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AuxiliaryReportSchema, HarnessEvent, type AuxiliaryCall, type Usage } from "@agentkitai/agentrig-core";

const text = z.string().min(1).max(4096);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dollars = z.number().finite().nonnegative();
const role = z.enum(["main", "subagent", "supervisor", "memory", "compaction", "other"]);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const lane = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_REQUIRED", "NOT_RUN"]);
export const EvaluationChecks = z.object({
  task: text, runId: z.string().uuid(), outcome: z.enum(["PASS", "FAIL", "BLOCKED", "SKIP"]),
  behavior: lane.optional(), regression: lane.optional(), scope: lane.optional(), submittedTests: lane.optional(),
  manual: z.enum(["PENDING", "NOT_REQUIRED"]).optional(), evidence: z.array(z.string().max(256 * 1024)).max(100),
  skipReason: text.optional(),
});
const Pricing = z.object({ input: dollars, output: dollars, cacheRead: dollars.optional(), cacheWrite: dollars.optional() }).strict();
export const EvaluationManifest = z.object({
  version: z.literal(1), runId: z.string().uuid(), task: text, evaluatorRevision: sha, startingRevision: sha,
  evidenceLane: z.enum(["scripted", "live"]),
  configuration: z.object({
    supervisor: z.boolean(), memory: z.boolean(), memoryCorpusSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    roles: z.array(z.object({ role, provider: text, model: text, usdPerMillionTokens: Pricing.optional() }).strict()).min(1).max(24),
    budgets: z.object({ maxTurns: count.optional(), maxTokens: count.optional(), maxUsd: dollars.optional(), maxMinutes: dollars.optional() }).strict(),
  }).strict(),
  logs: z.array(z.object({ path: text, sessionId: text, role: z.enum(["main", "subagent"]) }).strict()).max(64),
  checks: text,
  humanVerdict: z.object({ assessor: text, outcome: z.enum(["PASS", "FAIL"]), reason: text, evidence: text }).strict().optional(),
  auxiliary: text.optional(),
  coverage: z.object({
    sessionLogsComplete: z.boolean(), auxiliaryComplete: z.boolean(),
    /** Evaluator attestation about costs not represented by token calls (e.g. backend charges). */
    externalCostsUsd: dollars.nullable(), evidence: z.array(text).min(1).max(32),
  }).strict(),
  timing: z.object({ startedAt: count, settledAt: count.nullable(), includesObserverAndMaintenance: z.boolean(), evidence: text }).strict(),
  changes: z.object({ independentlyChecked: z.boolean(), unintended: z.array(text).max(1000), evidence: text }).strict(),
}).strict();
export type EvaluationManifest = z.infer<typeof EvaluationManifest>;
export const EvaluationAuxiliary = z.object({
  snapshots: z.array(z.object({ sessionId: text, id: text, ts: count, final: z.boolean(), report: AuxiliaryReportSchema }).strict()).max(10_000),
  /** Compaction/other provider calls absent from session logs; evaluator must collect these. */
  calls: z.array(z.object({ id: text, role: z.enum(["compaction", "other"]), call: AuxiliaryReportSchema.shape.calls.element }).strict()).max(10_000),
}).strict();
export interface EvaluationInput {
  manifest: EvaluationManifest;
  checks: z.infer<typeof EvaluationChecks>;
  logs: Array<{ sessionId: string; events: HarnessEvent[] }>;
  auxiliary?: z.infer<typeof EvaluationAuxiliary>;
  evidenceDigests?: Record<string, string>;
}
type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number };
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function add(to: Counts, usage: Usage): void {
  for (const key of Object.keys(to) as Array<keyof Counts>) {
    to[key] += usage[key] ?? 0;
    if (!Number.isSafeInteger(to[key]) || to[key] < 0) throw new Error("unsafe aggregate token count");
  }
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Pure reduction. Inputs are evaluator-owned evidence, never the agent's completion claim. */
export function buildEvaluationReport(input: EvaluationInput) {
  const m = EvaluationManifest.parse(input.manifest);
  const checks = EvaluationChecks.parse(input.checks);
  const sidecar = EvaluationAuxiliary.parse(input.auxiliary ?? { snapshots: [], calls: [] });
  check(m.task === checks.task && m.runId === checks.runId, "independent checks belong to another task/run");
  check(m.configuration.memory ? m.configuration.memoryCorpusSha256 !== null : m.configuration.memoryCorpusSha256 === null,
    "memory configuration/corpus mismatch");
  check(m.timing.settledAt === null || m.timing.settledAt >= m.timing.startedAt, "negative outer wall time");
  const configs = new Map(m.configuration.roles.map((c) => [JSON.stringify([c.role, c.provider, c.model]), c]));
  check(configs.size === m.configuration.roles.length, "duplicate role/provider/model configuration");
  const ids = new Set(m.logs.map((l) => l.sessionId));
  check(ids.size === m.logs.length, "duplicate session log descriptor");
  check(input.logs.length === m.logs.length && new Set(input.logs.map((l) => l.sessionId)).size === ids.size, "missing/duplicate input logs");
  const warnings: string[] = [];
  const auxiliaryCoverage = m.coverage.auxiliaryComplete && m.auxiliary !== undefined && input.auxiliary !== undefined;
  const buckets = new Map<string, { role: z.infer<typeof role>; provider: string; model: string | null; calls: number;
    unknownUsageCalls: number; reportedUsage: Counts; pricedReportedUsd: number; unpricedCalls: number }>();
  const record = (which: z.infer<typeof role>, call: Pick<AuxiliaryCall, "provider" | "model" | "usage" | "usageComplete">) => {
    const key = JSON.stringify([which, call.provider, call.model ?? null]);
    let b = buckets.get(key);
    if (!b) { b = { role: which, provider: call.provider, model: call.model ?? null, calls: 0, unknownUsageCalls: 0,
      reportedUsage: zero(), pricedReportedUsd: 0, unpricedCalls: 0 }; buckets.set(key, b); }
    b.calls++;
    if (!call.usageComplete || call.usage === undefined) b.unknownUsageCalls++;
    if (call.usage) add(b.reportedUsage, call.usage);
    const config = configs.get(key);
    if (!config) warnings.push(`unconfigured usage identity: ${key}`);
    const rates = config?.usdPerMillionTokens;
    let unpriced = rates === undefined || call.usage === undefined;
    for (const category of Object.keys(zero()) as Array<keyof Counts>) {
      const tokens = call.usage?.[category] ?? 0;
      if (tokens === 0) continue;
      const rate = rates?.[category];
      if (rate === undefined) unpriced = true;
      else b.pricedReportedUsd += tokens * rate / 1_000_000;
    }
    if (unpriced) b.unpricedCalls++;
    check(Number.isFinite(b.pricedReportedUsd), "cost overflow");
  };
  const snapshots: Array<z.infer<typeof EvaluationAuxiliary>["snapshots"][number]> = [...sidecar.snapshots];
  const parents = new Map<string, string | undefined>();
  const spawned = new Map<string, string>();
  const sessionReasons: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  let logCoverage = m.coverage.sessionLogsComplete;
  let approvals = 0, permissionRequests = 0, permissionDenials = 0, toolErrors = 0, toolDenials = 0;
  let retrievalRequests = 0, retrievalSuccesses = 0, memoryReads = 0, errors = 0;
  let firstTs: number | null = null, lastTs: number | null = null;
  const interventions: Record<string, number> = {};
  const recordedChanges = new Set<string>();
  for (const log of input.logs) {
    const descriptor = m.logs.find((l) => l.sessionId === log.sessionId);
    check(descriptor, "unexpected session log");
    const events = log.events.map((e) => HarnessEvent.parse(e));
    const start = events[0];
    check(start?.type === "session.start", "evaluation needs a fresh session.start log");
    check(start.sessionId === log.sessionId, "wrong session envelope");
    parents.set(log.sessionId, start.parent);
    if (descriptor.role === "main") check(start.parent === undefined, "main log is a child session");
    check(configs.has(JSON.stringify([descriptor.role, start.provider, start.model])), "session provider/model does not match configuration");
    let pending: { retries: number } | undefined;
    const toolCalls = new Map<string, string>();
    const toolResults = new Set<string>();
    let ended = false;
    for (const [i, e] of events.entries()) {
      check(e.sessionId === log.sessionId && (i === 0 || e.seq === events[i - 1]!.seq + 1), "non-contiguous/wrong-session log");
      check(!ended, "events after session.end");
      check(i === 0 || !["session.start", "session.resume", "session.fork"].includes(e.type), "mixed/resumed evaluation log is unsupported");
      check(e.ts >= m.timing.startedAt && (m.timing.settledAt === null || e.ts <= m.timing.settledAt), "event outside declared run window");
      firstTs = firstTs === null ? e.ts : Math.min(firstTs, e.ts); lastTs = lastTs === null ? e.ts : Math.max(lastTs, e.ts);
      if (e.type === "model.request") { check(!pending, "overlapping main requests"); pending = { retries: 0 }; }
      if (e.type === "model.retry") { check(pending, "retry without request"); pending.retries++; }
      if (e.type === "model.response") {
        check(pending, "response without request");
        record(descriptor.role, { provider: start.provider, model: start.model, usage: e.usage, usageComplete: e.usageComplete === true });
        for (let n = 0; n < pending.retries; n++) record(descriptor.role, { provider: start.provider, model: start.model, usageComplete: false });
        pending = undefined;
      }
      if (e.type === "session.end") { ended = true; sessionReasons[log.sessionId] = e.reason; }
      if (e.type === "auxiliary.usage") snapshots.push({ sessionId: e.sessionId, id: e.id, ts: e.ts, final: e.final, report: e.report });
      if (e.type === "subagent.spawn") { check(!spawned.has(e.id), "duplicate child session reference"); spawned.set(e.id, e.sessionId); }
      if (e.type === "permission.request") permissionRequests++;
      if (e.type === "permission.decision") { if (e.d === "allow") approvals++; if (e.d === "deny") permissionDenials++; }
      if (e.type === "tool.denied") toolDenials++;
      if (e.type === "tool.call") {
        check(!toolCalls.has(e.id), "duplicate tool call id"); toolCalls.set(e.id, e.name);
        if (e.name === "memory_search") retrievalRequests++;
        if (e.name === "memory_read") memoryReads++;
      }
      if (e.type === "tool.result") {
        check(toolCalls.has(e.id) && !toolResults.has(e.id), "unknown/duplicate tool result"); toolResults.add(e.id);
        if (!e.ok) toolErrors++; if (e.ok && toolCalls.get(e.id) === "memory_search") retrievalSuccesses++;
      }
      if (e.type === "error") errors++;
      if (e.type === "file.changed") recordedChanges.add(e.path);
      if (e.type === "supervisor.intervention") interventions[e.intervention.type] = (interventions[e.intervention.type] ?? 0) + 1;
    }
    if (pending) for (let n = 0; n <= pending.retries; n++) record(descriptor.role, { provider: start.provider, model: start.model, usageComplete: false });
    if (!ended) { logCoverage = false; sessionReasons[log.sessionId] = null; warnings.push(`unfinished session: ${log.sessionId}`); }
  }
  check(checks.outcome === "SKIP" ? m.logs.length === 0 && sidecar.snapshots.length === 0 && sidecar.calls.length === 0
    : m.logs.filter((l) => l.role === "main").length === 1, "one main log required, except a pre-run SKIP with no work");
  for (const [child, parent] of spawned) if (!ids.has(child)) { logCoverage = false; warnings.push(`missing child log: ${child}`); }
  else check(parents.get(child) === parent, "child log parent does not match spawn");
  for (const log of m.logs) if (log.role === "subagent") check(spawned.has(log.sessionId), "unreferenced child log");
  const latest = new Map<string, typeof snapshots[number]>();
  // Millisecond clocks can tie across event/sidecar channels. A final snapshot supersedes
  // provisional snapshots at the same instant; later contradictory snapshots still fail.
  for (const s of snapshots.sort((a, b) => a.ts - b.ts || Number(a.final) - Number(b.final))) {
    check(ids.has(s.sessionId), "auxiliary snapshot has unknown session");
    check(s.ts >= m.timing.startedAt && (m.timing.settledAt === null || s.ts <= m.timing.settledAt), "auxiliary snapshot outside run window");
    const key = JSON.stringify([s.sessionId, s.id]); const old = latest.get(key);
    if (old?.final) { check(s.final && JSON.stringify(old.report) === JSON.stringify(s.report), "conflicting snapshot after auxiliary final"); continue; }
    if (old) check(old.report.operation === s.report.operation, "auxiliary run changed operation");
    const total = zero(); for (const call of s.report.calls) if (call.usage) add(total, call.usage);
    const declared = zero(); add(declared, s.report.reportedUsage);
    check(JSON.stringify(total) === JSON.stringify(declared), "auxiliary aggregate disagrees with calls");
    check(s.report.unknownUsageCalls === s.report.calls.filter((c) => !c.usageComplete || c.usage === undefined).length, "auxiliary unknown count disagrees with calls");
    latest.set(key, s);
  }
  let unfinishedAuxiliaryRuns = 0;
  for (const s of latest.values()) {
    if (!s.final) unfinishedAuxiliaryRuns++;
    for (const c of s.report.calls) record(["reviewer", "grader"].includes(s.report.operation) ? "supervisor" : "memory",
      { ...c, usageComplete: s.final && c.usageComplete });
  }
  const callIds = new Set<string>();
  for (const c of sidecar.calls) { check(!callIds.has(c.id), "duplicate additional auxiliary call"); callIds.add(c.id); record(c.role, c.call); }
  const aggregate = (isMain: boolean) => {
    const selected = [...buckets.values()].filter((b) => (b.role === "main" || b.role === "subagent") === isMain);
    const usage = zero(); for (const b of selected) add(usage, b.reportedUsage);
    const unknownUsageCalls = selected.reduce((n, b) => n + b.unknownUsageCalls, 0);
    const unpricedCalls = selected.reduce((n, b) => n + b.unpricedCalls, 0);
    const pricedReportedUsd = selected.reduce((n, b) => n + b.pricedReportedUsd, 0);
    check(Number.isFinite(pricedReportedUsd), "aggregate cost overflow");
    const complete = logCoverage && (isMain || (auxiliaryCoverage && unfinishedAuxiliaryRuns === 0));
    return { calls: selected.reduce((n, b) => n + b.calls, 0), reportedUsage: usage, unknownUsageCalls,
      coverageComplete: complete, pricedReportedUsd, unpricedCalls,
      costUsd: complete && unknownUsageCalls === 0 && unpricedCalls === 0 ? pricedReportedUsd : null };
  };
  const main = aggregate(true), auxiliary = aggregate(false);
  if (!logCoverage) warnings.push("session-log coverage incomplete");
  if (!auxiliaryCoverage) warnings.push("auxiliary collection incomplete; absent receipts are not zero usage");
  if (unfinishedAuxiliaryRuns) warnings.push(`${unfinishedAuxiliaryRuns} unfinished auxiliary runs`);
  const wallMs = m.timing.settledAt !== null && m.timing.includesObserverAndMaintenance ? m.timing.settledAt - m.timing.startedAt : null;
  if (wallMs === null) warnings.push("outer settled wall time including observer/maintenance is unknown");
  let outcome = checks.outcome;
  if (outcome === "SKIP") check(checks.skipReason, "SKIP requires a pre-run operator reason");
  else {
    const lanes = [checks.behavior, checks.regression, checks.scope, checks.submittedTests];
    if (outcome === "FAIL" || lanes.includes("FAIL") || m.changes.unintended.length || m.humanVerdict?.outcome === "FAIL") outcome = "FAIL";
    else if ([checks.behavior, checks.regression, checks.scope].some((l) => l !== "PASS")
      || !["PASS", "NOT_REQUIRED"].includes(checks.submittedTests ?? "") || !m.changes.independentlyChecked) outcome = "BLOCKED";
    else if (checks.manual === "PENDING") outcome = m.humanVerdict?.outcome === "PASS" ? "PASS" : "BLOCKED";
    else if (checks.manual !== "NOT_REQUIRED") outcome = "BLOCKED";
  }
  const totalCostUsd = main.costUsd !== null && auxiliary.costUsd !== null && m.coverage.externalCostsUsd !== null
    ? main.costUsd + auxiliary.costUsd + m.coverage.externalCostsUsd : null;
  check(totalCostUsd === null || Number.isFinite(totalCostUsd), "total cost overflow");
  const { evidence: checkDiagnostics, ...checkSummary } = checks;
  return { version: 1, runId: m.runId, task: m.task, outcome, evidenceLane: m.evidenceLane, independentChecks: checkSummary, humanVerdict: m.humanVerdict ?? null,
    agentEndReasons: sessionReasons, configuration: m.configuration, evaluatorRevision: m.evaluatorRevision, startingRevision: m.startingRevision,
    wallMs, eventSpanMs: firstTs === null || lastTs === null ? null : lastTs - firstTs,
    main, auxiliary: { ...auxiliary, unfinishedRuns: unfinishedAuxiliaryRuns }, totalCostUsd,
    externalCostsUsd: m.coverage.externalCostsUsd, byRole: [...buckets.values()],
    permissions: { requests: permissionRequests, allowDecisions: approvals, denyDecisions: permissionDenials },
    toolErrors, toolDenials, errors, interventions, retrievals: { requests: retrievalRequests, successfulToolResults: retrievalSuccesses, pageReadRequests: memoryReads },
    changes: { ...m.changes, eventReportedPaths: [...recordedChanges].sort() },
    coverage: { ...m.coverage, sessionLogsComplete: logCoverage, auxiliaryComplete: auxiliaryCoverage }, timing: m.timing,
    evidence: { logs: m.logs, checks: m.checks, diagnosticEntries: checkDiagnostics.length, auxiliary: m.auxiliary ?? null, sha256: input.evidenceDigests ?? {} },
    warnings: [...new Set(warnings)] };
}

/** Bounded, read-only bundle loading. No automatic traversal or access outside the named bundle. */
export async function readEvaluationReport(manifestPath: string) {
  const absolute = await realpath(manifestPath); const root = dirname(absolute);
  const digests: Record<string, string> = Object.create(null) as Record<string, string>; let totalBytes = 0;
  const read = async (path: string, cap: number): Promise<string> => {
    check(!isAbsolute(path), "bundle paths must be relative");
    const file = await realpath(resolve(root, path)); const rel = relative(root, file);
    check(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "bundle path escapes its root");
    check((await lstat(file)).isFile(), "bundle inputs must be regular files");
    // Preflight avoids blocking on a stable FIFO. POSIX nonblocking/no-follow also closes the
    // final-component replacement window; this is still not a hostile-parent-path sandbox.
    const handle = await open(file, process.platform === "win32" ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      check((await handle.stat()).isFile(), "bundle inputs must be regular files");
      const buffer = Buffer.alloc(cap + 1); let bytes = 0;
      while (bytes <= cap) { const next = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!next.bytesRead) break; bytes += next.bytesRead; }
      check(bytes <= cap, "bundle file byte limit exceeded"); totalBytes += bytes; check(totalBytes <= 32 * 1024 * 1024, "bundle total byte limit exceeded");
      const data = buffer.subarray(0, bytes); digests[path] = createHash("sha256").update(data).digest("hex"); return data.toString("utf8");
    } finally { await handle.close(); }
  };
  const manifest = EvaluationManifest.parse(JSON.parse(await read(relative(root, absolute), 256 * 1024)));
  const checks = EvaluationChecks.parse(JSON.parse(await read(manifest.checks, 1024 * 1024)));
  const logs = [];
  for (const entry of manifest.logs) {
    const data = await read(entry.path, 8 * 1024 * 1024);
    check(data.endsWith("\n"), "unterminated event log");
    const lines = data.slice(0, -1).split("\n"); check(lines.length <= 100_000, "event count limit exceeded");
    logs.push({ sessionId: entry.sessionId, events: lines.map((line) => HarnessEvent.parse(JSON.parse(line))) });
  }
  const auxiliary = manifest.auxiliary === undefined ? undefined : EvaluationAuxiliary.parse(JSON.parse(await read(manifest.auxiliary, 8 * 1024 * 1024)));
  return buildEvaluationReport({ manifest, checks, logs, ...(auxiliary === undefined ? {} : { auxiliary }), evidenceDigests: digests });
}

export function formatEvaluationReport(report: ReturnType<typeof buildEvaluationReport>): string {
  const cost = (value: number | null) => value === null ? "unknown" : `$${value.toFixed(6)}`;
  const usage = (u: Counts) => `${u.input} in / ${u.output} out / ${u.cacheRead} cache-read / ${u.cacheWrite} cache-write`;
  return [
    `${report.task} ${report.runId}: ${report.outcome} (${report.evidenceLane}; independent checks; agent: ${Object.values(report.agentEndReasons).join(", ")})`,
    `Wall incl. observer/maintenance: ${report.wallMs === null ? "unknown" : `${report.wallMs} ms`}; total cost: ${cost(report.totalCostUsd)}`,
    `Main + child reported: ${usage(report.main.reportedUsage)}; unknown calls: ${report.main.unknownUsageCalls}; cost: ${cost(report.main.costUsd)}`,
    `Auxiliary reported: ${usage(report.auxiliary.reportedUsage)}; unknown calls: ${report.auxiliary.unknownUsageCalls}; unfinished runs: ${report.auxiliary.unfinishedRuns}; cost: ${cost(report.auxiliary.costUsd)}`,
    `Allows/denies: ${report.permissions.allowDecisions}/${report.permissions.denyDecisions}; tool errors: ${report.toolErrors}; unintended changes: ${report.changes.independentlyChecked ? report.changes.unintended.length : "unknown"}`,
    `Interventions: ${JSON.stringify(report.interventions)}; retrieval requests/successful tool results: ${report.retrievals.requests}/${report.retrievals.successfulToolResults}`,
    ...report.warnings.map((w) => `Warning: ${w}`),
  ].join("\n");
}
