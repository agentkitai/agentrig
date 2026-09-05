import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext, ModelEvent, ModelProvider } from "@agentkitai/agentrig-core";
import { dreamOnSessionEnd, FileMemoryStore, ingestOnSessionEnd, markDreamed } from "@agentkitai/agentrig-memory";

function scripted(bodies: unknown[]): ModelProvider {
  let n = 0;
  return {
    id: "fake",
    model: "fake-1",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(): AsyncIterable<ModelEvent> {
      const body = bodies[Math.min(n++, bodies.length - 1)];
      yield { type: "text_delta", text: typeof body === "string" ? body : JSON.stringify(body) };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

const exploding: ModelProvider = {
  id: "fake",
  model: "fake-1",
  capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<ModelEvent> {
    throw new Error("the model must not be called");
  },
};

let dir: string;
const ctx = (sessionId: string): HookContext => ({
  point: "session_end",
  sessionId,
  cwd: dir,
  turn: 3,
  summary: { id: sessionId, reason: "done", turns: 3, usage: { input: 1, output: 1 } },
  signal: new AbortController().signal,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentrig-mh-"));
  await mkdir(join(dir, "raw", "sessions"), { recursive: true });
  const store = new FileMemoryStore({ root: join(dir, "wiki") });
  await store.init();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeLog(id: string): Promise<void> {
  await writeFile(
    join(dir, "raw", "sessions", `${id}.jsonl`),
    JSON.stringify({ type: "session.start", task: "fix the retry logic", cwd: "/w" }) + "\n",
    "utf8",
  );
}

describe("ingestOnSessionEnd (PLAN §3.2's session_end trigger)", () => {
  it("keeps scheduled backend failure diagnostics visible while local ingest succeeds", async () => {
    await writeLog("s1"); const errors: string[] = []; const done: string[] = [];
    const hook = ingestOnSessionEnd({ dir, provider: scripted([{ facts: [{ pageType: "concept", slug: "retry", tag: "observed", text: "Retry per request" }] }]),
      backend: { id: "lore", onIngest: async () => { throw new Error("backend offline"); }, recall: async () => [], promote: async () => {} },
      onBackendError: (operation, error) => errors.push(`${operation}: ${error.message}`), onDone: text => done.push(text),
    });
    expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
    expect(errors).toEqual(["onIngest: backend offline"]);
    expect(done[0]).toContain("ingested 1 fact");
  });

  it("forwards bounds and reports failure before auxiliary completion without pre-ingest init", async () => {
    await writeLog("s1");
    const order: string[] = [];
    const init = vi.spyOn(FileMemoryStore.prototype, "init");
    try {
      const hook = ingestOnSessionEnd({ dir, provider: scripted([{ nothingDurable: true }]),
        limits: { maxOutputChars: 2 }, maxSpanChars: 1000,
        onError: error => order.push(`error:${error.message}`), onDone: text => order.push(`done:${text}`) });
      expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
      expect(init).not.toHaveBeenCalled();
      expect(order).toHaveLength(2);
      expect(order[0]).toContain("output limit"); expect(order[1]).toContain("auxiliary ingest");
      expect(order[1]).toContain("local writes not-started");
    } finally { init.mockRestore(); }
  });

  it("keeps an extended run budget below its outer hook timeout", () => {
    const hook = ingestOnSessionEnd({ dir, provider: exploding, limits: { timeoutMs: 900_000 } });
    expect(hook.timeoutMs).toBe(960_000);
  });

  it("surfaces uninspected evidence in the completion notice", async () => {
    await writeFile(join(dir, "raw", "sessions", "s1.jsonl"), JSON.stringify({
      type: "tool.result", ok: true, display: "recorded prefix only", truncated: true,
    }) + "\n");
    const done: string[] = [];
    const hook = ingestOnSessionEnd({ dir, provider: scripted([{ nothingDurable: true }]), onDone: text => done.push(text) });
    expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
    expect(done[0]).toContain("1 uninspected evidence omission(s)");
  });

  it("distils the session that just ended into the wiki", async () => {
    await writeLog("s1");
    const done: string[] = [];
    const hook = ingestOnSessionEnd({
      dir,
      // coverage planning is deterministic; the only model call per span is the distillation
      provider: scripted([
        {
          nothingDurable: false,
          summary: "retry logic",
          facts: [{ pageType: "concept", slug: "retry", tag: "stated", text: "retries are per request" }],
        },
      ]),
      onDone: (s) => done.push(s),
    });

    expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
    const page = await readFile(join(dir, "wiki", "concepts", "retry.md"), "utf8");
    expect(page).toContain("retries are per request");
    expect(done[0]).toContain("ingested");
    expect(done).toHaveLength(2);
    expect(done[1]).toContain("auxiliary ingest");
  });

  it("is a no-op when the session wrote no log — nothing to distil, no model call", async () => {
    const hook = ingestOnSessionEnd({ dir, provider: exploding });
    expect(await hook.handler(ctx("never-logged"))).toEqual({ action: "continue" });
  });

  it("a failed ingest never changes the session's outcome", async () => {
    await writeLog("s1");
    const errors: Error[] = [];
    const hook = ingestOnSessionEnd({
      dir,
      provider: scripted(["not json at all"]),
      onError: (e) => errors.push(e),
    });
    // continue, always: a session that finished its work has finished it
    expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
    // ...but the failure is REPORTED, not swallowed
    expect(errors).toHaveLength(1);
  });

  it("carries a generous timeout — ingest is a multi-call distillation, not a callback", async () => {
    const hook = ingestOnSessionEnd({ dir, provider: exploding });
    expect(hook.timeoutMs).toBeGreaterThan(60_000);
    expect(hook.point).toBe("session_end");
  });
});

describe("dreamOnSessionEnd (PLAN §3.7's scheduled trigger)", () => {
  it("does not fire before the thresholds are reached", async () => {
    await markDreamed(join(dir, "wiki"), Date.now());
    await writeLog("s1");
    const done: string[] = [];
    const errors: Error[] = [];
    const hook = dreamOnSessionEnd({
      dir,
      // `exploding` throws if the model is reached, so "didn't fire" is distinguishable from
      // "fired and crashed" — the earlier version could not tell those apart
      provider: exploding,
      everySessions: 10,
      everyHours: 24,
      onDone: (s) => done.push(s),
      onError: (e) => errors.push(e),
    });
    expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
    expect(done).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("fires once enough sessions have accumulated", async () => {
    await markDreamed(join(dir, "wiki"), 1);
    for (const id of ["a", "b", "c"]) await writeLog(id);
    const done: string[] = [];
    const hook = dreamOnSessionEnd({
      dir,
      everySessions: 2,
      everyHours: 999_999,
      structuralOnly: true,
      onDone: (s) => done.push(s),
    });
    expect(await hook.handler(ctx("c"))).toEqual({ action: "continue" });
    expect(done).toHaveLength(1);
  });

  it("fires on the hour threshold even with few sessions", async () => {
    await markDreamed(join(dir, "wiki"), 1);
    await writeLog("a");
    const done: string[] = [];
    const hook = dreamOnSessionEnd({
      dir,
      everySessions: 1000,
      everyHours: 1,
      structuralOnly: true,
      now: () => 10 * 3_600_000,
      onDone: (s) => done.push(s),
    });
    await hook.handler(ctx("a"));
    expect(done).toHaveLength(1);
  });

  it("REPORTS rather than applies by default — PLAN §1.5 makes review the default", async () => {
    await markDreamed(join(dir, "wiki"), 1);
    const store = new FileMemoryStore({ root: join(dir, "wiki") });
    await store.write("concepts/a.md", {
      path: "concepts/a.md",
      frontmatter: {
        type: "concept", slug: "a", aliases: [], sources: ["session:s1"],
        updated: "2026-08-01", confidence: "high",
      },
      body: "- [stated] alpha (session:s1)\n",
    });
    const before = await readFile(join(dir, "wiki", "concepts", "a.md"), "utf8");
    for (const id of ["a", "b"]) await writeLog(id);

    const done: string[] = [];
    const hook = dreamOnSessionEnd({
      dir, everySessions: 1, everyHours: 999_999, structuralOnly: true, onDone: (s) => done.push(s),
    });
    await hook.handler(ctx("b"));

    // an automatic dream that applied itself would be the least reviewable thing in the system
    expect(await readFile(join(dir, "wiki", "concepts", "a.md"), "utf8")).toBe(before);
    expect(done[0]).toMatch(/review|clean/);
  });

  it("applies only when explicitly asked, keeping the previous wiki", async () => {
    await markDreamed(join(dir, "wiki"), 1);
    for (const id of ["a", "b"]) await writeLog(id);
    const done: string[] = [];
    const hook = dreamOnSessionEnd({
      dir, everySessions: 1, everyHours: 999_999, structuralOnly: true, auto: true, onDone: (s) => done.push(s),
    });
    await hook.handler(ctx("b"));
    expect(done[0]).toContain("dream applied");
    expect(done[0]).toContain("previous wiki kept at");
  });

  it("retains and names a stale auto-apply artifact and its manifest", async () => {
    await writeLog("a");
    const store = new FileMemoryStore({ root: join(dir, "wiki") });
    await store.write("concepts/a.md", { path: "concepts/a.md", body: "- [stated] a durable fact (doc:fixture)",
      frontmatter: { type: "concept", slug: "a", aliases: [], sources: ["doc:fixture"], updated: "2026-09-05", confidence: "high" } });
    let changed = false;
    const provider: ModelProvider = { ...scripted([{}]), async *stream() {
      await store.appendLog("a cooperating write during consolidation"); changed = true;
      yield { type: "text_delta", text: "{}" };
      yield { type: "stop", reason: "end_turn" };
    } };
    const errors: Error[] = []; const done: string[] = [];
    const hook = dreamOnSessionEnd({ dir, provider, everySessions: 1, auto: true,
      onError: error => errors.push(error), onDone: text => done.push(text) });
    expect(await hook.handler(ctx("a"))).toEqual({ action: "continue" });
    expect(changed).toBe(true); expect(done).toEqual([]);
    expect(errors).toHaveLength(1); expect(errors[0]!.message).toContain("stale dream snapshot");
    const retained = /dream artifact retained at (.*); manifest: (.*)$/.exec(errors[0]!.message)!;
    expect(retained).not.toBeNull();
    const output = retained[1]!; const manifestPath = retained[2]!;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.outputRoot).toBe(output);
      expect(await readFile(join(output, "index.md"), "utf8")).toContain("# Index");
      expect(await readFile(join(store.root, "log.md"), "utf8")).toContain("cooperating write");
    } finally {
      // These are the exact artifacts created by this test's hook, verified by its manifest.
      await rm(output, { recursive: true, force: true }); await rm(manifestPath, { force: true });
    }
  });

  it("stays free without a provider — structural only, no model call", async () => {
    await markDreamed(join(dir, "wiki"), 1);
    for (const id of ["a", "b"]) await writeLog(id);
    const hook = dreamOnSessionEnd({ dir, provider: exploding, everySessions: 1, everyHours: 1, structuralOnly: true });
    expect(await hook.handler(ctx("b"))).toEqual({ action: "continue" });
  });

  it("a failed dream never changes the session's outcome", async () => {
    await writeLog("a");
    await writeLog("b");
    await rm(join(dir, "wiki"), { recursive: true, force: true });
    await writeFile(join(dir, "wiki"), "not a directory", "utf8");
    const errors: Error[] = [];
    const hook = dreamOnSessionEnd({
      dir, everySessions: 1, everyHours: 1, structuralOnly: true, onError: (e) => errors.push(e),
    });
    expect(await hook.handler(ctx("s1"))).toEqual({ action: "continue" });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("the ingest hook cannot be pointed outside .agentrig", () => {
  it("refuses a traversing session id rather than reading and distilling an arbitrary file", async () => {
    // `--resume '../../../home/user/notes'` made this read a file outside .agentrig, feed it to
    // the model, and distil it into the agent's persistent memory
    // written inside this test's own temp dir but OUTSIDE raw/sessions, so nothing shared is
    // touched and the traversal is still real
    await writeFile(
      join(dir, "secret.jsonl"),
      JSON.stringify({ type: "session.start", task: "SECRET", cwd: "/w" }) + "\n",
      "utf8",
    );
    const errors: Error[] = [];
    const hook = ingestOnSessionEnd({
      dir,
      // exploding: proving the model is never reached is the point
      provider: exploding,
      onError: (e) => errors.push(e),
    });

    expect(await hook.handler(ctx("../../secret"))).toEqual({ action: "continue" });
    expect(errors.some((e) => e.message.includes("refusing to ingest"))).toBe(true);
  });

  it("core refuses such an id long before the hook ever sees it", async () => {
    const { assertSessionId } = await import("@agentkitai/agentrig-core");
    expect(() => assertSessionId("../../secret")).toThrow(/invalid session id/);
  });
});
