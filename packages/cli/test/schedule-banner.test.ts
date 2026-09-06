import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TuiController } from "../src/tui/controller.js";
import { ScheduleReports } from "../src/schedule-report.js";

const harness = vi.hoisted(() => ({
  writes: [] as string[], mounted: false, failMount: false,
  exercise: undefined as undefined | ((controller: TuiController) => Promise<void>),
}));
// Keep real startTui, builder, controller, App and Ink; substitute terminal streams only.
vi.mock("ink", async importOriginal => {
  const actual = await importOriginal<typeof import("ink")>();
  const { EventEmitter } = await import("node:events");
  class Input extends EventEmitter {
    isTTY = true; setEncoding() { return this; } setRawMode() { return this; }
    ref() { return this; } unref() { return this; } read() { return null; }
  }
  return { ...actual, render: (element: { props: { controller: TuiController } }, options: object) => {
    if (harness.failMount) throw new Error("terminal mount failed");
    const output = Object.assign(new EventEmitter(), { columns: 120, rows: 35, isTTY: true,
      write: (value: string) => { harness.writes.push(value); return true; } });
    const instance = actual.render(element as never, { ...options, stdin: new Input() as never, stdout: output as never, stderr: output as never, patchConsole: false });
    const exited = instance.waitUntilExit();
    harness.mounted = true;
    return { ...instance, waitUntilExit: async () => {
      try { await harness.exercise!(element.props.controller); }
      finally { instance.unmount(); await exited; instance.cleanup(); }
    } };
  } };
});
import { startTui } from "../src/tui/start.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; harness.writes = []; harness.mounted = false; harness.failMount = false; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-banner-"))); roots.push(root);
  const project = join(root, "project"); await mkdir(project);
  const reports = new ScheduleReports(project);
  await reports.append({ ts: Date.now(), minute: 1, entry: "nightly", source: "schedule", sessionId: null, outcome: "error", maintenanceFailed: false, accounting: null });
  return { root, project, reports };
}
async function start(f: Awaited<ReturnType<typeof fixture>>, trusted = true) {
  vi.stubEnv("OPENAI_API_KEY", "inert-fixture");
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try { await startTui({ root: join(f.root, "sessions"), provider: "openai", model: "fixture", modelExplicit: true, baseUrl: "http://127.0.0.1:1/v1", maxTurns: "1", maxTokensPerTurn: "100",
    repoMap: false, packages: false, extensionDiscovery: false, skillDiscovery: false,
    ...(trusted ? { trustedProjectRoot: f.project } : {}) }); expect(harness.mounted).toBe(true); expect(process.exitCode ?? 0).toBe(0); }
  finally { if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", descriptor); }
}

it("actual startup renders the failure frame before acknowledging only its snapshot, leaving a concurrent failure pending", async () => {
  const f = await fixture();
  let completed!: () => void; const acked = new Promise<void>(resolve => { completed = resolve; });
  let reject!: (error: unknown) => void; const failed = new Promise<never>((_resolve, r) => { reject = r; });
  const original = ScheduleReports.prototype.acknowledge;
  vi.spyOn(ScheduleReports.prototype, "acknowledge").mockImplementation(async function (through) {
    try {
      expect(harness.writes.join("")).toContain("1 scheduled runs failed");
      // Arrives after the displayed snapshot and before acknowledgement commits.
      await f.reports.append({ ts: Date.now(), minute: 2, entry: "later", source: "heartbeat", sessionId: null, outcome: "budget", maintenanceFailed: false, accounting: null });
      await original.call(this, through); completed();
    } catch (error) { reject(error); throw error; }
  });
  harness.exercise = async controller => {
    expect(controller.snapshot().lines.some(line => line.text.includes("scheduled runs failed"))).toBe(true);
    // The timeout is only a hang guard; the actual rendered-frame/ack event releases the test.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([acked, failed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("frame acknowledgement never settled")), 5000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    expect(await f.reports.notice()).toMatchObject({ through: 2, failures: 1 });
  };
  await start(f);
});

it("untrusted startup leaves failure accounting untouched and prints no project banner", async () => {
  const f = await fixture(); const ack = vi.spyOn(ScheduleReports.prototype, "acknowledge");
  harness.exercise = async controller => {
    expect(controller.snapshot().lines.some(line => line.text.includes("scheduled runs failed"))).toBe(false);
    expect((await f.reports.notice()).failures).toBe(1);
  };
  await start(f, false); expect(ack).not.toHaveBeenCalled();
});

it("an unmounted startup cannot acknowledge a queued failure notice", async () => {
  const f = await fixture(); const ack = vi.spyOn(ScheduleReports.prototype, "acknowledge");
  harness.failMount = true;
  await expect(start(f)).rejects.toThrow("terminal mount failed");
  expect(ack).not.toHaveBeenCalled(); expect((await f.reports.notice()).failures).toBe(1);
});

it("a lost receipt remains visible in the next real frame even after normal acknowledgement", async () => {
  const f = await fixture(); const lock = join(f.project, ".agentrig/schedule-report.lock");
  await writeFile(lock, "other owner");
  await expect(f.reports.append({ ts: Date.now(), minute: 2, entry: "lost", source: "schedule", sessionId: null, outcome: "error", maintenanceFailed: false, accounting: null })).rejects.toThrow("busy");
  await f.reports.markUncertain(); await rm(lock);
  harness.exercise = async controller => { expect(controller.snapshot().lines.some(line => line.text.includes("receipts are missing or uncertain"))).toBe(true); };
  await start(f);
  expect(harness.writes.join("").replace(/\s+/gu, " ")).toContain("receipts are missing or uncertain");
  expect((await f.reports.notice()).uncertain).toBe(true);
});
