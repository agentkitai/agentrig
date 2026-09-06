import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, RulePolicy, SessionStore, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { cronDue, ScheduleStore } from "../src/schedule.js";
import { buildProgram } from "../src/program.js";
import { renderEvent } from "../src/render.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-schedule-"))); roots.push(root);
  const project = join(root, "project"); const home = join(root, "home");
  await mkdir(project); await mkdir(home);
  return { root, project, home, store: new ScheduleStore(project) };
}
const now = new Date("2026-09-06T12:30:00Z");
const entry = (id: string, cron = "30 12 * * *") => ({ id, cron, task: "literal $HOME {{date}}; do not interpolate" });

it.each([
  ["30 12 * * *", true], ["31 12 * * *", false], ["*/15 10-13 * 1,9 0", true],
  ["30 12 7 * 0", true], ["30 12 6 * 1", true], ["30 12 7 * 1", false],
  ["30 12 * * 1", false], ["30 12 7 * *", false],
])("matches explicit UTC cron/day semantics: %s", (cron, expected) => expect(cronDue(cron as string, now)).toBe(expected));

it("validates bounded grammar/flags and never accepts authority fields", async () => {
  const f = await fixture();
  for (const cron of ["@hourly", "0 0 * * 7", "60 0 * * *", "1/2 * * * *", "*/0 * * * *", "* * * *", "5-1 * * * *"]) await expect(f.store.add(entry("bad", cron))).rejects.toThrow();
  await expect(f.store.add({ ...entry("bad"), flags: { yolo: true } })).rejects.toThrow();
  await expect(f.store.add({ ...entry("bad"), lastClaimedMinute: 0 })).rejects.toThrow();
  await expect(f.store.add({ ...entry("bad"), flags: { maxTurns: 51 } })).rejects.toThrow();
  await expect(f.store.add({ ...entry("bad"), task: "x".repeat(8193) })).rejects.toThrow();
  await f.store.add(entry("one")); await expect(f.store.add(entry("one"))).rejects.toThrow("already exists");
  await f.store.remove("one"); expect((await f.store.read()).entries).toEqual([]);
  await expect(f.store.remove("missing")).rejects.toThrow("unknown");
});

it("previews without claiming, executes exactly due entries once and has no catch-up", async () => {
  const f = await fixture(); await f.store.add(entry("due")); await f.store.add(entry("other", "31 12 * * *"));
  expect(await f.store.tick(now)).toEqual(["due"]);
  expect((await f.store.read()).entries[0]?.lastClaimedMinute).toBeUndefined();
  const launch = vi.fn(async () => {});
  expect(await f.store.tick(now, launch)).toEqual(["due"]); expect(launch).toHaveBeenCalledTimes(1);
  expect(await f.store.tick(now, launch)).toEqual([]); expect(launch).toHaveBeenCalledTimes(1);
  expect(await f.store.tick(new Date("2026-09-05T12:30:00Z"), launch)).toEqual([]);
  expect(await f.store.tick(new Date("2026-09-06T12:32:00Z"), launch)).toEqual([]);
});

it("serializes cooperating ticks and mutations until actual launched work settles", async () => {
  const f = await fixture(); await f.store.add(entry("one"));
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const running = f.store.tick(now, async () => { entered(); await pending; });
  await started;
  try {
    await expect(new ScheduleStore(f.project).tick(now, async () => {})).rejects.toThrow("scheduler busy");
    await expect(f.store.add(entry("two"))).rejects.toThrow("scheduler busy");
    expect((await f.store.read()).entries[0]?.lastClaimedMinute).toBe(Math.floor(now.getTime() / 60_000));
  } finally { release(); await running; }
  expect(await f.store.tick(now, async () => {})).toEqual([]);
});

it("retains failed claims, refuses over-cap ticks before any launch, and stops after cancellation", async () => {
  const f = await fixture(); await f.store.add(entry("one"));
  await expect(f.store.tick(now, async () => { throw new Error("launch failed"); })).rejects.toThrow("launch failed");
  expect(await f.store.tick(now, async () => {})).toEqual([]);
  for (let i = 0; i < 11; i++) await f.store.add(entry(`extra${i}`));
  const launch = vi.fn(async () => {});
  await expect(f.store.tick(now, launch)).rejects.toThrow("more than 10"); expect(launch).not.toHaveBeenCalled();
  await f.store.remove("extra10");
  const controller = new AbortController();
  await expect(f.store.tick(now, async () => { controller.abort(); }, controller.signal)).rejects.toThrow();
  expect((await f.store.read()).entries.filter(e => e.lastClaimedMinute !== undefined)).toHaveLength(2);
});

it("rejects outside directory aliases and symlinked tables without changing the target", async () => {
  const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside);
  await symlink(outside, join(f.project, ".agentrig"), "junction");
  await expect(f.store.add(entry("one"))).rejects.toThrow("unsafe");
  await rm(join(f.project, ".agentrig")); await mkdir(join(f.project, ".agentrig"));
  const target = join(outside, "target.json"); await writeFile(target, "untouched");
  // A directory junction covers Windows without requiring file-symlink privileges.
  await symlink(outside, join(f.project, ".agentrig", "schedule.json"), "junction");
  await expect(f.store.read()).rejects.toThrow("unsafe");
});

it("bounds malformed/oversized table reads", async () => {
  const f = await fixture(); await mkdir(join(f.project, ".agentrig"));
  const path = join(f.project, ".agentrig", "schedule.json");
  await writeFile(path, " ".repeat(256 * 1024 + 1)); await expect(f.store.read()).rejects.toThrow("256 KiB");
  await writeFile(path, JSON.stringify({ version: 1, entries: [entry("one"), entry("one")] })); await expect(f.store.read()).rejects.toThrow("duplicate");
});

it("actual CLI stays offline by default and requires trusted explicit execution with literal bounded flags", async () => {
  const f = await fixture(); const run = vi.fn(async () => {});
  const deps = { run, config: { cwd: f.project, home: f.home }, scheduleNow: () => now };
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  await buildProgram(deps).parseAsync(["schedule", "add", "one", "30 12 * * *", entry("one").task], { from: "user" });
  await writeFile(join(f.project, ".agentrig", "config.json"), "INVALID CONFIG MUST NOT BE READ BY PREVIEW");
  await buildProgram(deps).parseAsync(["schedule", "tick"], { from: "user" }); expect(run).not.toHaveBeenCalled();
  await expect(buildProgram(deps).parseAsync(["schedule", "tick", "--execute"], { from: "user" })).rejects.toThrow("requires trusted");
  await writeFile(join(f.project, ".agentrig", "config.json"), "{}");
  await buildProgram(deps).parseAsync(["schedule", "tick", "--execute", "--trust"], { from: "user" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(entry("one").task, expect.objectContaining({ headless: true, maxTurns: "5", maxTokens: "10000", maxMinutes: "5", scheduled: { entryId: "one", minute: Math.floor(now.getTime() / 60_000) } }));
  await buildProgram(deps).parseAsync(["schedule", "tick", "--execute", "--trust"], { from: "user" }); expect(run).toHaveBeenCalledTimes(1);
});

it("actual scheduled provider/storage path remains advisory and denies fresh exec despite blanket allow; ordinary user task executes", async () => {
  const f = await fixture(); const requests: ModelRequest[] = []; const execute = vi.fn(async () => ({ output: "ran", display: "ran" }));
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(request) { requests.push(structuredClone(request)); yield { type: "tool_use", id: "call", name: "command", input: {} }; yield { type: "stop", reason: "tool_use" }; } };
  const store = new SessionStore({ root: join(f.root, "sessions") });
  const agent = createAgent({ provider, store, systemPrompt: "fixture", budget: { maxTurns: 1 }, permissions: new RulePolicy([], "allow"),
    tools: [{ name: "command", description: "fixture", inputSchema: z.object({}), permission: "exec", execute }] });
  await f.store.add(entry("one"));
  let sessionId = "";
  await f.store.tick(now, async (item, minute) => { const session = agent.run(item.task, { cwd: f.project, scheduled: { entryId: item.id, minute } }); sessionId = session.id; await session.done; });
  expect(execute).not.toHaveBeenCalled();
  const events = await store.readAll(sessionId);
  const scheduled = events.find(e => e.type === "run.scheduled"); expect(scheduled).toMatchObject({ entryId: "one" }); expect(renderEvent(scheduled!)).toContain("advisory");
  expect(events).toContainEqual(expect.objectContaining({ type: "permission.expansion", decision: "deny" }));
  expect(requests[0]?.messages[0]?.content[0]).toMatchObject({ trust: "project", context: { authority: "advisory" } });
  const normal = agent.run("execute command", { cwd: f.project }); await normal.done; expect(execute).toHaveBeenCalledTimes(1);
});

it("cancellation joins an actual scheduled session before releasing the tick lock and leaves later entries unclaimed", async () => {
  const f = await fixture(); await f.store.add(entry("first")); await f.store.add(entry("second"));
  const controller = new AbortController(); let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let settled = false;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(_request, signal) { started(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }); settled = true; yield { type: "stop", reason: "end_turn" }; } };
  const store = new SessionStore({ root: join(f.root, "sessions") });
  const agent = createAgent({ provider, store, tools: [], systemPrompt: "fixture", budget: { maxTurns: 1 }, permissions: new RulePolicy([], "deny") });
  let id = "";
  const running = f.store.tick(now, async (item, minute) => {
    const session = agent.run(item.task, { cwd: f.project, scheduled: { entryId: item.id, minute } }); id = session.id;
    controller.signal.addEventListener("abort", () => session.control.abort(), { once: true });
    await session.done;
  }, controller.signal);
  const rejection = expect(running).rejects.toThrow();
  await entered; controller.abort(); await rejection;
  expect(settled).toBe(true);
  expect((await store.readAll(id)).at(-1)).toMatchObject({ type: "session.end", reason: "aborted" });
  expect((await f.store.read()).entries.map(e => e.lastClaimedMinute !== undefined)).toEqual([true, false]);
  await f.store.remove("second"); // proves the held lock was released only after the join
});
