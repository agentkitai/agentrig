import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, type AuxiliaryReport, type HarnessEvent } from "@agentkitai/agentrig-core";
import { ScheduleReports, ScheduleReceipt, ScheduledUsage, type ReceiptInput } from "../src/schedule-report.js";
import { ScheduleStore } from "../src/schedule.js";
import { buildProgram } from "../src/program.js";

const roots: string[] = [];
const now = new Date("2026-09-06T12:30:00Z");
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-reports-"))); roots.push(root);
  const project = join(root, "project"); const home = join(root, "home"); await mkdir(project); await mkdir(home);
  return { root, project, home, reports: new ScheduleReports(project), schedules: new ScheduleStore(project) };
}
const input = (outcome: ReceiptInput["outcome"] = "error"): ReceiptInput => ({ ts: now.getTime(), minute: Math.floor(now.getTime() / 60000), entry: "one", source: "schedule", sessionId: null, outcome, maintenanceFailed: false, accounting: null });

it("acknowledgement diagnostics identify the operational file without echoing its content", async () => {
  const f = await fixture(); await f.reports.append(input());
  const ack = join(f.project, ".agentrig/schedule.ack.json");
  await writeFile(ack, "SECRET_ACK_CANARY");
  for (const read of [() => f.reports.notice(), () => f.reports.acknowledge(1)]) {
    const error = await read().catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(".agentrig/schedule.ack.json");
    expect((error as Error).message).toContain("retained without overwrite");
    expect((error as Error).message).not.toContain("SECRET_ACK_CANARY");
  }
  expect(await readFile(ack, "utf8")).toBe("SECRET_ACK_CANARY");
  await writeFile(ack, Buffer.from([0xff]));
  await expect(f.reports.notice()).rejects.toThrow("invalid UTF-8 in scheduled state .agentrig/schedule.ack.json; retained without overwrite");
  expect(await readFile(ack)).toEqual(Buffer.from([0xff]));
});

it("records bounded structured outcomes and acknowledges only the observed cutoff, not newer failures", async () => {
  const f = await fixture(); expect((await f.reports.notice()).text).toBeNull();
  const first = await f.reports.append(input()); expect(first.seq).toBe(1);
  const shown = await f.reports.notice(); expect(shown.text).toContain("1 scheduled runs failed");
  await f.reports.append(input("budget"));
  await f.reports.acknowledge(shown.through);
  expect(await f.reports.notice()).toMatchObject({ through: 2, failures: 1, omitted: false });
  await f.reports.acknowledge(2); await f.reports.acknowledge(1);
  expect((await f.reports.notice()).text).toBeNull();
  await expect(f.reports.acknowledge(3)).rejects.toThrow("unseen");
  const bytes = await readFile(join(f.project, ".agentrig/schedule.log"), "utf8");
  expect(bytes.trim().split("\n").map(line => ScheduleReceipt.parse(JSON.parse(line)))).toHaveLength(2);
  await rm(join(f.project, ".agentrig/schedule.log"));
  await expect(f.reports.notice()).rejects.toThrow("log missing");
});

it("retention exposes omitted unacknowledged history rather than silently reporting no failures", async () => {
  const f = await fixture(); await mkdir(join(f.project, ".agentrig"));
  // Seed valid retained history directly; append itself supplies the tested 513th receipt.
  const lines = Array.from({ length: 512 }, (_, i) => JSON.stringify({ ...input(i === 0 ? "error" : "done"), version: 1, seq: i + 1 }));
  await writeFile(join(f.project, ".agentrig/schedule.log"), lines.join("\n") + "\n");
  await f.reports.append(input("done"));
  const notice = await f.reports.notice(); expect(notice).toMatchObject({ failures: 0, omitted: true, through: 513 });
  expect(notice.text).toContain("failure count is incomplete");
  expect(notice.text).toContain("failure count is unknown");
  expect(notice.text).not.toContain("0 scheduled runs failed");
  expect((await readFile(join(f.project, ".agentrig/schedule.log"), "utf8")).trim().split("\n")).toHaveLength(512);
  await f.reports.acknowledge(notice.through); expect((await f.reports.notice()).text).toBeNull();
});

it("refuses malformed, oversized, aliased or locked state without overwriting it", async () => {
  const f = await fixture(); const dir = join(f.project, ".agentrig"); await mkdir(dir);
  const path = join(dir, "schedule.log");
  for (const bytes of ["BROKEN", "x".repeat(512 * 1024 + 1)]) {
    await writeFile(path, bytes); await expect(f.reports.append(input())).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes);
  }
  await rm(path); await symlink(f.home, path, "junction");
  await expect(f.reports.append(input())).rejects.toThrow("unsafe"); await rm(path);
  await writeFile(join(dir, "schedule-report.lock"), "existing owner");
  await expect(f.reports.append(input())).rejects.toThrow("scheduled reports busy; stop writers before recovering .agentrig/schedule-report.lock; acknowledgement is .agentrig/schedule.ack.json");
  expect(await readFile(join(dir, "schedule-report.lock"), "utf8")).toBe("existing owner");
});

const event = (e: Record<string, unknown>) => ({ seq: 0, ts: 0, ...e }) as HarnessEvent;
const usage = { input: 10, output: 2 };
const prices = { inputUsdPerMTok: 1, outputUsdPerMTok: 2 };
const report = (n: number): AuxiliaryReport => ({ operation: "ingest", outcome: "completed", durationMs: 1, reportedUsage: { input: n, output: 1 }, unknownUsageCalls: 0, costUsd: 0.01, calls: [{ operation: "extract", provider: "fixture", outcome: "completed", durationMs: 1, usageComplete: true, usage: { input: n, output: 1 } }] });
function main(collector: ScheduledUsage, complete = true) { collector.observe(event({ type: "model.request" })); collector.observe(event({ type: "model.response", usageComplete: complete })); }

it("replaces auxiliary snapshots and keeps unknown costs, missing final usage, child coverage and overflow partial", () => {
  const collector = new ScheduledUsage(true); main(collector);
  collector.ingest(report(2), false); collector.ingest(report(7), true);
  expect(collector.finish(usage, prices, false)).toMatchObject({ auxiliary: { usage: { input: 7 }, complete: true }, coverage: "complete" });
  expect(collector.finish(usage, undefined, false).costUsd).toBeNull();
  collector.observe(event({ type: "subagent.spawn" })); expect(collector.finish(usage, prices, false)).toMatchObject({ coverage: "partial", costUsd: null });
  const unfinished = new ScheduledUsage(true); main(unfinished); unfinished.ingest(report(2), false);
  expect(unfinished.finish(usage, prices, false)).toMatchObject({ coverage: "partial", costUsd: null });
  const missing = new ScheduledUsage(); main(missing, false); expect(missing.finish(usage, prices, false).main.complete).toBe(false);
  const cached = new ScheduledUsage(); main(cached);
  expect(cached.finish({ ...usage, cacheRead: 10 }, prices, false, 0.1).main.costUsd).toBe(15 / 1e6);
  const overflow = new ScheduledUsage(); main(overflow);
  for (let i = 0; i < 129; i++) overflow.observe(event({ type: "auxiliary.usage", id: String(i), final: true, report: report(1) }));
  expect(overflow.finish(usage, prices, false)).toMatchObject({ coverage: "partial", costUsd: null, auxiliary: { usage: { input: 128 } } });
});

it.each([[undefined, false], [false, false], [true, false], [true, true]] as const)("actual CLI ingests the actual session once with a custom memory root (explicit ingest=%s, failed maintenance=%s)", async (ingestOnEnd, failedMaintenance) => {
  const f = await fixture(); const memory = join(f.root, "custom-memory");
  // The injected config directory does not change the runtime's cwd. Keep real tool writes
  // inside this fixture so the narrow write_file allow rule retains its cwd-only scope.
  vi.spyOn(process, "cwd").mockReturnValue(f.project);
  await f.schedules.add({ id: "one", cron: "30 12 * * *", task: "Write capture.txt, then finish cleanly", flags: { maxTurns: 2 } });
  await writeFile(join(f.project, ".agentrig/config.json"), JSON.stringify({ memory, ...(ingestOnEnd === undefined ? {} : { ingestOnEnd }),
    allow: ["write_file"], checkpoints: false, repoMap: false, packages: false, extensionDiscovery: false, skillDiscovery: false, ingestLimits: { maxCalls: 1 }, priceIn: "1", priceOut: "2" }));
  vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-credential"); vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume actual adapter request */ }
    calls++;
    const content = calls === 2 ? "Nothing further is required." : JSON.stringify({ facts: [], ...(!failedMaintenance ? { nothingDurable: true } : {}) });
    const delta = calls === 1 ? { tool_calls: [{ index: 0, id: "capture-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: join(f.project, "capture.txt"), content: "durable work\n" }) } }] } : { content };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
    const deps = { config: { cwd: f.project, home: f.home }, scheduleNow: () => now };
    const args = ["schedule", "tick", "--execute", "--trust", "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`];
    await buildProgram(deps).parseAsync(args, { from: "user" });
    expect(calls).toBe(ingestOnEnd === false ? 2 : 3); expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(failedMaintenance ? 1 : 0);
    const receipt = ScheduleReceipt.parse(JSON.parse(await readFile(join(f.project, ".agentrig/schedule.log"), "utf8")));
    expect(receipt).toMatchObject({ outcome: "done", source: "schedule", maintenanceFailed: failedMaintenance, accounting: { main: { usage: { input: 20, output: 4 }, complete: true } } });
    expect((await f.reports.notice()).failures).toBe(failedMaintenance ? 1 : 0);
    const store = new SessionStore({ root: join(f.project, ".agentrig/raw/sessions") });
    const events = await store.readAll(receipt.sessionId!);
    expect(events.at(-1)).toMatchObject({ type: "session.end" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.result", id: "capture-write", permission: "write", ok: true }));
    expect(await readFile(join(f.project, "capture.txt"), "utf8")).toBe("durable work\n");
    if (ingestOnEnd !== false && !failedMaintenance) {
      expect(await readFile(join(memory, "wiki/sources", `session-${receipt.sessionId}.md`), "utf8")).toContain(receipt.sessionId!);
      expect(receipt.accounting?.auxiliary.usage?.input).toBe(10);
    } else await expect(readFile(join(memory, "wiki/sources", `session-${receipt.sessionId}.md`))).rejects.toMatchObject({ code: "ENOENT" });
    await buildProgram(deps).parseAsync(args, { from: "user" }); expect(calls).toBe(ingestOnEnd === false ? 2 : 3);
    expect((await readFile(join(f.project, ".agentrig/schedule.log"), "utf8")).trim().split("\n")).toHaveLength(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("launch or reporting failure stays visible with retained claims, and never retries completed model work", async () => {
  const f = await fixture(); await f.schedules.add({ id: "one", cron: "30 12 * * *", task: "one" });
  const run = vi.fn(async () => { throw new Error("private error text must not enter durable receipt"); });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const deps = { run, config: { cwd: f.project, home: f.home }, scheduleNow: () => now };
  await buildProgram(deps).parseAsync(["schedule", "tick", "--execute", "--trust"], { from: "user" });
  const bytes = await readFile(join(f.project, ".agentrig/schedule.log"), "utf8");
  expect(bytes).not.toContain("private"); expect(JSON.parse(bytes)).toMatchObject({ outcome: "error", sessionId: null, accounting: null });
  expect((await f.reports.notice()).failures).toBe(1); expect(process.exitCode).toBe(1);
  await f.schedules.add({ id: "two", cron: "30 12 * * *", task: "two" });
  await writeFile(join(f.project, ".agentrig/schedule-report.lock"), "other owner");
  run.mockResolvedValueOnce(undefined as never);
  await buildProgram(deps).parseAsync(["schedule", "tick", "--execute", "--trust"], { from: "user" });
  expect(errors.mock.calls.flat().join(" ")).toContain("failure history may be incomplete; do not retry execution");
  expect(process.exitCode).toBe(1); expect(run).toHaveBeenCalledTimes(2);
  const marker = join(f.project, ".agentrig/schedule-report-uncertain.json");
  const markerBytes = await readFile(marker, "utf8"); await f.reports.markUncertain();
  expect(await readFile(marker, "utf8")).toBe(markerBytes);
  await rm(join(f.project, ".agentrig/schedule-report.lock"));
  expect((await f.reports.notice()).text).toContain("receipts are missing or uncertain");
  await f.reports.acknowledge(1); expect((await f.reports.notice()).uncertain).toBe(true);
  await buildProgram(deps).parseAsync(["schedule", "tick", "--execute", "--trust"], { from: "user" });
  expect(run).toHaveBeenCalledTimes(2);
});

it("marker write failure remains a visible nonzero result without replacing an unsafe marker", async () => {
  const f = await fixture(); await f.schedules.add({ id: "one", cron: "30 12 * * *", task: "one" });
  await symlink(f.home, join(f.project, ".agentrig/schedule-report-uncertain.json"), "junction");
  const run = vi.fn(async () => {}); const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await buildProgram({ run, config: { cwd: f.project, home: f.home }, scheduleNow: () => now }).parseAsync(["schedule", "tick", "--execute", "--trust"], { from: "user" });
  expect(run).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(1);
  expect(errors.mock.calls.flat().join(" ")).toContain("stderr/exit status are the only failure record");
  expect((await f.schedules.read()).entries[0]?.lastClaimedMinute).toBe(input().minute);
});
