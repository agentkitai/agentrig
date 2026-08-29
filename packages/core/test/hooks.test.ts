import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  builtinTools,
  createAgent,
  defaultRules,
  mergePatches,
  runHooks,
  RulePolicy,
  SessionStore,
  type AnyTool,
  type HarnessEvent,
  type Hook,
  type ModelEvent,
  type ModelProvider,
} from "@agentkitai/agentrig-core";

/** Scripted provider: each turn consumes the next ModelEvent[]. No network. */
class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(): AsyncIterable<ModelEvent> {
    yield* this.turns.shift() ?? [{ type: "stop", reason: "end_turn" }];
  }
}

const usage = (i: number, o: number): ModelEvent => ({ type: "usage", usage: { input: i, output: o } });
const stop = (r: "end_turn" | "tool_use"): ModelEvent => ({ type: "stop", reason: r });

const echoTool = (): AnyTool => ({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  permission: "read",
  paths: () => [],
  execute: async (input: { text: string }) => ({ output: input.text, display: `echo: ${input.text}` }),
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-hooks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(turns: ModelEvent[][], hooks: Hook[], tools: AnyTool[] = [echoTool()]) {
  return createAgent({
    provider: new FakeProvider(turns),
    tools,
    permissions: new RulePolicy([{ class: "read", decision: "allow" }, ...defaultRules]),
    systemPrompt: "test",
    store: new SessionStore({ root }),
    hooks,
    budget: { maxTurns: 10 },
    maxTokensPerTurn: 100,
  }).run("do the thing", { cwd: root });
}

async function collect(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

const callEcho = (text: string): ModelEvent[] => [
  { type: "tool_use", id: "t1", name: "echo", input: { text } },
  usage(1, 1),
  stop("tool_use"),
];

describe("a hook can never break the session", () => {
  it("a throwing hook is reported and the session still finishes", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "user_prompt", id: "boom", handler: () => { throw new Error("hook bug"); } }],
    );
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("hook boom failed"))).toBe(true);
  });

  it("a hanging hook is timed out rather than wedging the loop", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "user_prompt", id: "slow", timeoutMs: 30, handler: () => new Promise(() => {}) }],
    );
    const t0 = Date.now();
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("did not finish within"))).toBe(true);
  });

  it("a hook returning nonsense is reported, not applied", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "user_prompt", id: "junk", handler: () => ({ nope: true }) as never }],
    );
    const events = await collect(session);
    expect((await session.done).reason).toBe("done");
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("returned no action"))).toBe(true);
  });

  it("an action a point does not support is reported, not applied", async () => {
    // `session_end` cannot deny anything — the session is already over
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "session_end", id: "late", handler: () => ({ action: "deny", reason: "too late" }) }],
    );
    const events = await collect(session);
    expect((await session.done).reason).toBe("done");
    expect(
      events.some((e) => e.type === "error" && (e as { message: string }).message.includes("session_end does not support")),
    ).toBe(true);
  });
});

describe("pre_tool", () => {
  it("denies a call, and the denial is recorded like a permission denial", async () => {
    const session = run(
      [callEcho("secret"), [usage(1, 1), stop("end_turn")]],
      [{ point: "pre_tool", id: "guard", handler: () => ({ action: "deny", reason: "not allowed" }) }],
    );
    const events = await collect(session);
    await session.done;

    expect(events.some((e) => e.type === "tool.denied")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(false);
  });

  it("sees the PARSED input, not raw JSON", async () => {
    let seen: unknown;
    const session = run(
      [callEcho("hello"), [usage(1, 1), stop("end_turn")]],
      [{ point: "pre_tool", handler: (ctx) => { seen = ctx.tool?.input; return { action: "continue" }; } }],
    );
    await collect(session);
    await session.done;
    expect(seen).toEqual({ text: "hello" });
  });

  it("a modify patch is re-validated against the tool's own schema", async () => {
    const session = run(
      [callEcho("original"), [usage(1, 1), stop("end_turn")]],
      [{ point: "pre_tool", handler: () => ({ action: "modify", patch: { text: "rewritten" } }) }],
    );
    const events = await collect(session);
    await session.done;
    const result = events.find((e) => e.type === "tool.result") as { display: string };
    expect(result.display).toContain("rewritten");
  });

  it("a patch that breaks the schema is rejected and the original input is used", async () => {
    const session = run(
      [callEcho("original"), [usage(1, 1), stop("end_turn")]],
      [{ point: "pre_tool", handler: () => ({ action: "modify", patch: { text: 42 } }) }],
    );
    const events = await collect(session);
    await session.done;

    const result = events.find((e) => e.type === "tool.result") as { display: string };
    expect(result.display).toContain("original");
    expect(
      events.some((e) => e.type === "error" && (e as { message: string }).message.includes("did not match its schema")),
    ).toBe(true);
  });

  it("the first deny wins and stops the chain", async () => {
    let secondRan = false;
    const session = run(
      [callEcho("x"), [usage(1, 1), stop("end_turn")]],
      [
        { point: "pre_tool", id: "a", handler: () => ({ action: "deny", reason: "first" }) },
        { point: "pre_tool", id: "b", handler: () => { secondRan = true; return { action: "continue" }; } },
      ],
    );
    await collect(session);
    await session.done;
    expect(secondRan).toBe(false);
  });
});

describe("post_tool", () => {
  it("can rewrite what the model sees without rewriting the log", async () => {
    const session = run(
      [callEcho("sensitive"), [usage(1, 1), stop("end_turn")]],
      [{ point: "post_tool", handler: () => ({ action: "modify", patch: "[redacted]" }) }],
    );
    const events = await collect(session);
    const summary = await session.done;

    // the log keeps what the tool actually returned — a hook shapes the conversation, not history
    const logged = events.find((e) => e.type === "tool.result") as { display: string };
    expect(logged.display).toContain("sensitive");

    const store = new SessionStore({ root });
    const replayed: HarnessEvent[] = [];
    for await (const e of store.read(summary.id)) replayed.push(e);
    expect(replayed.some((e) => e.type === "tool.result" && (e as { display: string }).display.includes("sensitive"))).toBe(true);
  });
});

describe("user_prompt", () => {
  it("can refuse the task outright", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "user_prompt", handler: () => ({ action: "deny", reason: "off limits" }) }],
    );
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("error");
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("off limits"))).toBe(true);
  });

  it("can append context to the task", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "user_prompt", handler: () => ({ action: "inject", message: "also remember X" }) }],
    );
    await collect(session);
    expect((await session.done).reason).toBe("done");
  });
});

describe("pre_compact", () => {
  it("a veto stops compaction and is recorded", async () => {
    const session = createAgent({
      // a tool call keeps the loop going long enough to reach the compaction check
      provider: new FakeProvider([callEcho("a"), callEcho("b"), [usage(1, 1), stop("end_turn")]]),
      tools: [echoTool()],
      permissions: new RulePolicy([{ class: "read", decision: "allow" }, ...defaultRules]),
      systemPrompt: "test",
      store: new SessionStore({ root }),
      hooks: [{ point: "pre_compact", handler: () => ({ action: "deny", reason: "keep the history" }) }],
      compaction: { shouldCompact: () => true, compact: async (m) => m.slice(-1) },
      budget: { maxTurns: 3 },
      maxTokensPerTurn: 100,
    }).run("t", { cwd: root });
    const events = await collect(session);
    await session.done;
    expect(
      events.some((e) => e.type === "error" && (e as { message: string }).message.includes("compaction skipped by hook")),
    ).toBe(true);
    expect(events.some((e) => e.type === "context.compact")).toBe(false);
  });
});

describe("session_end", () => {
  it("runs before session.end is written, so a hook can still append to the log", async () => {
    let sawSummary: unknown;
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "session_end", handler: (ctx) => { sawSummary = ctx.summary; return { action: "continue" }; } }],
    );
    const events = await collect(session);
    const summary = await session.done;

    expect(sawSummary).toMatchObject({ id: summary.id, reason: "done" });
    // session.end is still the last line
    expect(events.at(-1)!.type).toBe("session.end");
  });

  it("a failing session_end hook does not change the session's outcome", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "session_end", id: "ingest", handler: async () => { throw new Error("ingest exploded"); } }],
    );
    await collect(session);
    expect((await session.done).reason).toBe("done");
  });
});

describe("runHooks", () => {
  const ctx = { sessionId: "s", cwd: "/w", turn: 0, signal: new AbortController().signal };

  it("accumulates patches and injects from several hooks, in order", async () => {
    const errors: string[] = [];
    const r = await runHooks(
      {
        hooks: [
          { point: "pre_tool", handler: () => ({ action: "modify", patch: { a: 1 } }) },
          { point: "pre_tool", handler: () => ({ action: "modify", patch: { b: 2 } }) },
        ],
        onError: (m) => errors.push(m),
      },
      "pre_tool",
      ctx,
    );
    expect(r.patches).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toEqual([]);
  });

  it("ignores hooks registered at a different point", async () => {
    let ran = false;
    await runHooks(
      {
        hooks: [{ point: "session_end", handler: () => { ran = true; return { action: "continue" }; } }],
        onError: () => {},
      },
      "pre_tool",
      ctx,
    );
    expect(ran).toBe(false);
  });
});

describe("mergePatches", () => {
  it("shallow-merges object patches in order", () => {
    expect(mergePatches({ a: 1, b: 1 }, [{ b: 2 }, { c: 3 }])).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("ignores non-object patches rather than clobbering the input", () => {
    expect(mergePatches({ a: 1 }, ["nope", null, 42, ["x"]])).toEqual({ a: 1 });
  });
});
