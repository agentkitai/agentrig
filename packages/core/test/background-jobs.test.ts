import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import {
  bashJobTool,
  bashTool,
  builtinTools,
  createAgent,
  JobRegistry,
  RulePolicy,
  SessionStore,
  type BashJobOutput,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
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
    const a = await bash().execute({ command: "sleep 2; echo A done", background: true }, ctx);
    const b = await bash().execute({ command: "sleep 2; echo B done", background: true }, ctx);
    const idA = a.display.match(/job-\d+/)![0];
    const idB = b.display.match(/job-\d+/)![0];
    const doneA = await waitForExit(idA);
    const doneB = await waitForExit(idB);
    // two sequential 2s sleeps would need 4s; the margin absorbs slow spawns on a loaded machine
    expect(Date.now() - t0).toBeLessThan(3_600);
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
    // the holder escapes the process group entirely (node spawns it detached with inherited
    // pipes), so this only resolves promptly if the grace-then-sever pipe teardown works — the
    // in-group `(sleep 30 &)` version passed even with the sever deleted
    const holder = `node -e "require('child_process').spawn('sleep',['6'],{detached:true,stdio:'inherit'}).unref()"`;
    const r = await bash().execute({ command: `echo alive; ${holder}; sleep 30`, background: true }, ctx);
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

  it("refuses background + timeoutMs with a PRESCRIPTIVE message naming the fix", async () => {
    // the vague version ("a background job has no timeout") sent a real agent into a three-retry
    // loop: it must say which parameter to drop and what to resend
    const r = await bash().execute({ command: "sleep 1", background: true, timeoutMs: 5_000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("remove timeoutMs");
    expect(r.display).toContain("background: true");
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

describe("review regressions", () => {
  it("kill on a failed-spawn job is a no-op — it must NEVER signal pid 0 or garbage", async () => {
    // observed via strace: child.kill on a spawn-failed handle issued kill(0, SIGKILL) — SIGKILL
    // to our own process group — and took the whole test runner down. If this regresses, the
    // suite dies with exit 137 rather than this assertion failing politely.
    const { id } = registry.start({
      command: "echo x",
      shellPath: "/no/such/shell-anywhere",
      cwd: root,
      isWindows: false,
      killTree: () => {},
      signal: ctx.signal,
    });
    registry.kill(id);
    registry.disposeAll();
    const status = await job().execute({ id, action: "status", waitMs: 3_000 }, ctx);
    expect((status.output as BashJobOutput).running).toBe(false);
  }, 10_000);

  it("a spawn failure is an error naming the reason, not a clean silent exit", async () => {
    const { id } = registry.start({
      command: "echo x",
      shellPath: "/no/such/shell-anywhere",
      cwd: root,
      isWindows: false,
      killTree: () => {},
      signal: ctx.signal,
    });
    const status = await job().execute({ id, action: "status", waitMs: 3_000 }, ctx);
    expect(status.isError).toBe(true);
    expect(status.display).toContain("never started");
    expect((status.output as BashJobOutput).spawnError).toContain("ENOENT");
  }, 10_000);

  it("waitMs on an already-aborted signal returns immediately — shutdown must not wait a deadline out", async () => {
    const r = await bash().execute({ command: "sleep 30", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    const aborted = new AbortController();
    aborted.abort();
    const t0 = Date.now();
    await job().execute({ id, action: "status", waitMs: 60_000 }, { ...ctx, signal: aborted.signal });
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 10_000);

  it("polling with waitMs does not accumulate abort listeners on the session signal", async () => {
    const r = await bash().execute({ command: "sleep 30", background: true }, ctx);
    const id = r.display.match(/job-\d+/)![0];
    for (let i = 0; i < 8; i += 1) {
      await job().execute({ id, action: "status", waitMs: 30 }, ctx);
    }
    // small settle so the post-race cleanup microtasks run
    await new Promise((res) => setTimeout(res, 50));
    expect(getEventListeners(abortCtl.signal, "abort").length).toBeLessThanOrEqual(2);
  }, 10_000);

  it("caps the unread buffer in real BYTES and reports only bytes actually dropped", async () => {
    const { id } = registry.start({
      // ~1.2MB of 2-byte characters, no trailing newline noise
      command: `node -e "process.stdout.write('\u00e9'.repeat(600000))"`,
      shellPath: "/bin/sh",
      cwd: root,
      isWindows: false,
      killTree: () => {},
      signal: ctx.signal,
    });
    const status = await job().execute({ id, action: "status", waitMs: 8_000 }, ctx);
    const out = status.output as BashJobOutput;
    const keptBytes = Buffer.byteLength(out.output, "utf8");
    expect(keptBytes).toBeLessThanOrEqual(512 * 1024);
    // total = kept + dropped, within one chunk of the 1.2MB written — nothing double-counted
    expect(keptBytes + out.droppedBytes).toBeGreaterThanOrEqual(1_200_000 - 65_536);
    expect(keptBytes + out.droppedBytes).toBeLessThanOrEqual(1_200_100);
    // the byte-boundary walk keeps a split character out of the front
    expect(out.output).not.toContain("\ufffd");
  }, 15_000);
});

// ---------------------------------------------------------------- session lifecycle

class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  constructor(private readonly turns: Array<ModelEvent[]>) {}
  async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
    const turn = this.turns.shift() ?? [{ type: "stop" as const, reason: "end_turn" as const }];
    yield* turn;
  }
}

describe("jobs die with the session, however it ends", () => {
  it("a session that ends DONE reaps its background jobs — not only an aborted one", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "sleep 60", background: true } },
        { type: "usage", usage: { input: 1, output: 1 } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "started it" },
        { type: "usage", usage: { input: 1, output: 1 } },
        { type: "stop", reason: "end_turn" },
      ],
    ]);
    const agent = createAgent({
      provider,
      tools: builtinTools(),
      permissions: new RulePolicy([{ class: "exec", decision: "allow" }, { class: "read", decision: "allow" }]),
      systemPrompt: "test",
      store: new SessionStore({ root }),
      budget: { maxTurns: 3 },
      maxTokensPerTurn: 100,
    });
    const session = agent.run("start a watcher", { cwd: root });
    let pid: number | undefined;
    for await (const e of session.events) {
      if (e.type === "tool.result" && /pid \d+/.test(e.display)) {
        pid = Number(e.display.match(/pid (\d+)/)![1]);
      }
    }
    const summary = await session.done;
    expect(summary.reason).toBe("done");
    expect(pid, "the job start should have reported a pid").toBeDefined();
    // The settled session's signal aborts as cleanup, which kills the process. Poll rather than
    // assert once: SIGKILL leaves a zombie until libuv reaps it, and kill(pid, 0) succeeds on a
    // zombie — but an UNKILLED `sleep 60` stays truly alive for the whole poll, so this still
    // fails loudly if the cleanup abort is removed.
    let gone = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000) {
      try {
        process.kill(pid!, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(gone, "the job should be dead and reaped, not still sleeping").toBe(true);
  }, 15_000);
});
