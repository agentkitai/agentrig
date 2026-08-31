import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashJobTool,
  bashTool,
  builtinTools,
  JobRegistry,
  type BashJobOutput,
  type ToolContext,
} from "@agentkitai/agentrig-core";

let root: string;
let ctx: ToolContext;
let abortCtl: AbortController;
let registry: JobRegistry;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-jobs-"));
  abortCtl = new AbortController();
  ctx = { cwd: root, sessionId: "s1", emit: () => {}, signal: abortCtl.signal };
  registry = new JobRegistry();
});
afterEach(async () => {
  registry.disposeAll();
  await rm(root, { recursive: true, force: true });
});

const bash = () => bashTool({ jobs: registry });
const job = () => bashJobTool(registry);

/** Poll status until the job exits — bounded, so a hang fails the test instead of the suite. */
async function waitForExit(id: string): Promise<BashJobOutput> {
  const r = await job().execute({ id, action: "status", waitMs: 8_000 }, ctx);
  expect((r.output as BashJobOutput).running, "job did not exit within the wait").toBe(false);
  return r.output as BashJobOutput;
}

describe("bash background jobs", () => {
  it("returns a job id immediately instead of waiting — the whole point", async () => {
    const t0 = Date.now();
    const r = await bash().execute({ command: "sleep 5; echo done", background: true }, ctx);
    expect(Date.now() - t0, "start must not wait for the command").toBeLessThan(2_000);
    expect(r.isError).toBeUndefined();
    expect(r.display).toContain("job-");
    // still running: the sleep has 5 seconds to go
    const id = r.display.match(/job-\d+/)![0];
    const status = await job().execute({ id, action: "status" }, ctx);
    expect((status.output as BashJobOutput).running).toBe(true);
  }, 10_000);

  it("two jobs run CONCURRENTLY — total wall time is the slower one, not the sum", async () => {
    const t0 = Date.now();
    const a = await bash().execute({ command: "sleep 1; echo A done", background: true }, ctx);
    const b = await bash().execute({ command: "sleep 1; echo B done", background: true }, ctx);
    const idA = a.display.match(/job-\d+/)![0];
    const idB = b.display.match(/job-\d+/)![0];
    const doneA = await waitForExit(idA);
    const doneB = await waitForExit(idB);
    // two sequential 1s sleeps would need 2s; concurrent ones finish together
    expect(Date.now() - t0).toBeLessThan(1_900);
    expect(doneA.output).toContain("A done");
    expect(doneB.output).toContain("B done");
  }, 10_000);

  it("status hands output over incrementally — a poll never resends what was already read", async () => {
    const r = await bash().execute({ command: "echo first; sleep 1.2; echo second", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    const first = await job().execute({ id, action: "status", waitMs: 600 }, ctx);
    expect((first.output as BashJobOutput).output).toContain("first");
    const second = await waitForExit(id);
    expect(second.output).toContain("second");
    expect(second.output, "already-read output must not repeat").not.toContain("first");
    expect(second.exitCode).toBe(0);
  }, 10_000);

  it("waitMs returns EARLY on exit, not at the deadline", async () => {
    const r = await bash().execute({ command: "echo quick", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    const t0 = Date.now();
    const status = await job().execute({ id, action: "status", waitMs: 60_000 }, ctx);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((status.output as BashJobOutput).running).toBe(false);
    expect((status.output as BashJobOutput).output).toContain("quick");
  }, 10_000);

  it("a non-zero exit is reported honestly but is not a tool error", async () => {
    const r = await bash().execute({ command: "echo oops >&2; exit 3", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    const done = await waitForExit(id);
    expect(done.exitCode).toBe(3);
    expect(done.output).toContain("oops");
  }, 10_000);

  it("kill stops the job and its children promptly, and drains what it said", async () => {
    const r = await bash().execute({ command: "echo alive; (sleep 30 &); sleep 30", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    // let the echo land
    await job().execute({ id, action: "status", waitMs: 500 }, ctx);
    const t0 = Date.now();
    const killed = await job().execute({ id, action: "kill" }, ctx);
    expect(Date.now() - t0, "kill must not wait out the sleeps").toBeLessThan(5_000);
    expect(killed.display).toContain(`killed ${id}`);
    const after = await job().execute({ id, action: "status" }, ctx);
    expect((after.output as BashJobOutput).running).toBe(false);
  }, 10_000);

  it("session abort kills running jobs — an aborted session leaves no invisible work", async () => {
    const r = await bash().execute({ command: "sleep 30", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    abortCtl.abort();
    const done = await job().execute({ id, action: "status", waitMs: 5_000 }, { ...ctx, signal: new AbortController().signal });
    expect((done.output as BashJobOutput).running).toBe(false);
  }, 10_000);

  it("refuses background + timeoutMs instead of silently ignoring the timeout", async () => {
    const r = await bash().execute({ command: "sleep 1", background: true, timeoutMs: 5_000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("no timeout");
  });

  it("refuses background when no registry is wired, honestly", async () => {
    const r = await bashTool().execute({ command: "echo x", background: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("not available");
  });

  it("an unknown job id is an error naming the jobs that do exist", async () => {
    await bash().execute({ command: "echo x", background: true }, ctx);
    const r = await job().execute({ id: "job-99", action: "status" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("no such job: job-99");
    expect(r.display).toContain("job-1");
  });

  it("builtinTools wires bash and bash_job to the SAME registry", async () => {
    type Exec = (input: unknown, c: ToolContext) => Promise<{ display: string; output: unknown }>;
    const tools = builtinTools();
    const bashT = tools.find((t) => t.name === "bash")!;
    const jobT = tools.find((t) => t.name === "bash_job")!;
    const started = await (bashT.execute as Exec)({ command: "echo wired", background: true }, ctx);
    const id = started.display.match(/job-\d+/)![0];
    const status = await (jobT.execute as Exec)({ id, action: "status", waitMs: 8_000 }, ctx);
    expect((status.output as BashJobOutput).output).toContain("wired");
  }, 10_000);
});
