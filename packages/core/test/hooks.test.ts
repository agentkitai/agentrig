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
  type ModelRequest,
} from "@agentkitai/agentrig-core";

/** Scripted provider: each turn consumes the next ModelEvent[]. No network. */
class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  /** Every request, deep-copied — several tests assert on what the MODEL actually saw. */
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
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
  return runWith(new FakeProvider(turns), hooks, tools);
}

function runWith(provider: FakeProvider, hooks: Hook[], tools: AnyTool[] = [echoTool()]) {
  return createAgent({
    provider,
    tools,
    permissions: new RulePolicy([{ class: "read", decision: "allow" }, ...defaultRules]),
    systemPrompt: "test",
    store: new SessionStore({ root }),
    hooks,
    budget: { maxTurns: 10 },
    maxTokensPerTurn: 100,
  }).run("do the thing", { cwd: root });
}

/** Every text block the model was sent, flattened — for asserting on the model's own view. */
function modelSaw(provider: FakeProvider): string {
  return provider.requests
    .flatMap((r) => r.messages.flatMap((m) => m.content.map((c) => JSON.stringify(c))))
    .join("\n");
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
  it("rewrites what the MODEL sees while the log keeps what the tool returned", async () => {
    const provider = new FakeProvider([callEcho("sensitive"), [usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      { point: "post_tool", handler: () => ({ action: "modify", patch: "[redacted]" }) },
    ]);
    const events = await collect(session);
    const summary = await session.done;

    // both halves matter: the model got the patch...
    expect(modelSaw(provider)).toContain("[redacted]");
    expect(modelSaw(provider)).not.toContain("echo: sensitive");
    // ...and the log kept the truth
    const logged = events.find((e) => e.type === "tool.result") as { display: string };
    expect(logged.display).toContain("sensitive");

    const store = new SessionStore({ root });
    const replayed: HarnessEvent[] = [];
    for await (const e of store.read(summary.id)) replayed.push(e);
    expect(replayed.some((e) => e.type === "tool.result" && (e as { display: string }).display.includes("sensitive"))).toBe(true);
  });

  it("records that a hook changed what the model consumed", async () => {
    // without this the log and the conversation could diverge unobserved: a hook could steer the
    // model with text no observer — the supervisor included — ever saw
    const session = run(
      [callEcho("x"), [usage(1, 1), stop("end_turn")]],
      [{ point: "post_tool", handler: () => ({ action: "inject", message: "extra guidance" }) }],
    );
    const events = await collect(session);
    await session.done;
    const patched = events.find((e) => e.type === "tool.result.patched") as { by: string; display: string };
    expect(patched).toBeDefined();
    expect(patched.by).toBe("post_tool");
    expect(patched.display).toContain("extra guidance");
  });

  it("bounds a hook injection before it reaches the model", async () => {
    const provider = new FakeProvider([callEcho("x"), [usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      { point: "post_tool", handler: () => ({ action: "inject", message: `${"z".repeat(40_000)}TAIL` }) },
    ]);
    const events = await collect(session);
    await session.done;
    const patched = events.find((event) => event.type === "tool.result.patched");
    expect(patched).toMatchObject({ type: "tool.result.patched", by: "post_tool" });
    if (patched?.type !== "tool.result.patched") throw new Error("missing patch");
    expect(patched.display.length).toBeLessThanOrEqual(30_000);
    expect(patched.display).toContain("zzzz");
    expect(patched.display).not.toContain("TAIL");
    expect(modelSaw(provider)).toContain("zzzz");
    expect(modelSaw(provider)).not.toContain("TAIL");
  });

  it("preserves bounded guidance after a tool throws an oversized error", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "throwing", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const throwing: AnyTool = {
      name: "throwing", description: "throws", inputSchema: z.object({}), permission: "read", paths: () => [],
      execute: async () => { throw new Error("e".repeat(40_000)); },
    };
    const session = runWith(provider, [
      { point: "post_tool", handler: () => ({ action: "inject", message: "THROWN GUIDANCE" }) },
    ], [throwing]);
    await collect(session);
    expect((await session.done).reason).toBe("done");
    expect(modelSaw(provider)).toContain("THROWN GUIDANCE");
  });

  it("keeps fitting guidance intact after a short thrown error", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "throwing", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const guidance = `${"g".repeat(20_000)}TAIL`;
    const throwing: AnyTool = {
      name: "throwing", description: "throws", inputSchema: z.object({}), permission: "read", paths: () => [],
      execute: async () => { throw new Error("short error"); },
    };
    const session = runWith(provider, [
      { point: "post_tool", handler: () => ({ action: "inject", message: guidance }) },
    ], [throwing]);
    await collect(session);
    expect((await session.done).reason).toBe("done");
    expect(modelSaw(provider)).toContain(guidance);
  });

  it("keeps a large in-bound result intact and shrinks injection to the remaining frame", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "large", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const large: AnyTool = {
      name: "large", description: "large bounded result", inputSchema: z.object({}),
      permission: "read", paths: () => [],
      execute: async () => ({ output: {}, display: "r".repeat(29_500) }),
    };
    const session = runWith(provider, [
      { point: "post_tool", handler: () => ({ action: "inject", message: "GUIDANCE".repeat(100) }) },
    ], [large]);
    await collect(session);
    expect((await session.done).reason).toBe("done");
    const seen = modelSaw(provider);
    expect(seen).toContain("r".repeat(29_500));
    expect(seen).toContain("GUIDANCE");
  });

  it("does not record a patch event when no hook changed anything", async () => {
    const session = run([callEcho("x"), [usage(1, 1), stop("end_turn")]], []);
    const events = await collect(session);
    await session.done;
    expect(events.some((e) => e.type === "tool.result.patched")).toBe(false);
  });

  it("reports a non-string patch instead of silently ignoring it", async () => {
    const session = run(
      [callEcho("x"), [usage(1, 1), stop("end_turn")]],
      [{ point: "post_tool", handler: () => ({ action: "modify", patch: { not: "a string" } }) }],
    );
    const events = await collect(session);
    await session.done;
    expect(
      events.some((e) => e.type === "error" && (e as { message: string }).message.includes("must be a string")),
    ).toBe(true);
  });

  it("sees the tool's display string, and its raw output whatever its type", async () => {
    let seen: unknown;
    const structured: AnyTool = {
      name: "structured",
      description: "returns an object",
      inputSchema: z.object({}),
      permission: "read",
      paths: () => [],
      execute: async () => ({ output: { exitCode: 0, stdout: "hi" }, display: "hi" }),
    };
    const session = run(
      [[{ type: "tool_use", id: "t1", name: "structured", input: {} }, usage(1, 1), stop("tool_use")], [usage(1, 1), stop("end_turn")]],
      [{ point: "post_tool", handler: (ctx) => { seen = ctx.result; return { action: "continue" }; } }],
      [structured],
    );
    await collect(session);
    await session.done;
    // `output` is NOT a string for most builtins; declaring it one crashed redaction hooks
    expect(seen).toEqual({ ok: true, display: "hi", output: { exitCode: 0, stdout: "hi" } });
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

describe("a hook influences the session through its return value or not at all", () => {
  it("mutating the context it was handed changes nothing", async () => {
    // ctx.request.messages WAS the live message array, so a hook returning `continue` — nothing
    // to validate — could push messages the model then saw, with zero events in the log
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      {
        point: "pre_model",
        handler: (ctx) => {
          ctx.request?.messages.push({ role: "user", content: [{ type: "text", text: "SMUGGLED" }] });
          if (ctx.request !== undefined) ctx.request.system = "HIJACKED";
          return { action: "continue" };
        },
      },
    ]);
    await collect(session);
    await session.done;

    expect(modelSaw(provider)).not.toContain("SMUGGLED");
    expect(provider.requests[0]!.system).not.toContain("HIJACKED");
  });

  it("a pre_compact hook cannot empty the live history", async () => {
    // pre_compact accepts no `modify` at all, yet emptying ctx.messages sent the next request
    // with messages: [] — a 400 against a real provider, from a point that cannot modify
    const provider = new FakeProvider([callEcho("a"), callEcho("b"), [usage(1, 1), stop("end_turn")]]);
    const session = createAgent({
      provider,
      tools: [echoTool()],
      permissions: new RulePolicy([{ class: "read", decision: "allow" }, ...defaultRules]),
      systemPrompt: "test",
      store: new SessionStore({ root }),
      hooks: [{ point: "pre_compact", handler: (ctx) => { ctx.messages?.splice(0); return { action: "continue" }; } }],
      compaction: { shouldCompact: () => true, compact: async (m) => m },
      budget: { maxTurns: 4 },
      maxTokensPerTurn: 100,
    }).run("t", { cwd: root });
    await collect(session);
    await session.done;
    expect(provider.requests.every((r) => r.messages.length > 0)).toBe(true);
  });

  it("mutating a tool input does not reach the permission check", async () => {
    // regression guard: pre_tool is applied BEFORE permissions are computed, so a patch is
    // policed — but only while that ordering holds. Reordering it would be silent otherwise.
    const session = run(
      [
        [{ type: "tool_use", id: "t1", name: "write_file", input: { path: "in-cwd.txt", content: "x" } }, usage(1, 1), stop("tool_use")],
        [usage(1, 1), stop("end_turn")],
      ],
      [{ point: "pre_tool", handler: () => ({ action: "modify", patch: { path: "/tmp/escaped-by-hook.txt" } }) }],
      builtinTools(),
    );
    const events = await collect(session);
    await session.done;

    const req = events.find((e) => e.type === "permission.request") as { req: { input: { path: string } } };
    // the policy sees the PATCHED path, so the patch cannot smuggle a write past cwd confinement
    expect(req.req.input.path).toBe("/tmp/escaped-by-hook.txt");
    expect(events.some((e) => e.type === "tool.denied")).toBe(true);
  });

  it("a hook denial produces the same event shape as a permission denial", async () => {
    const denied = run(
      [callEcho("x"), [usage(1, 1), stop("end_turn")]],
      [{ point: "pre_tool", handler: () => ({ action: "deny", reason: "no" }) }],
    );
    const hookEvents = await collect(denied);
    await denied.done;
    // no phantom tool.call: it would feed the stall detector's productivity count and the loop
    // detector's inputHash tally for a call that never ran
    expect(hookEvents.some((e) => e.type === "tool.call")).toBe(false);
    expect(hookEvents.some((e) => e.type === "tool.denied")).toBe(true);
  });
});

describe("pre_model and post_model", () => {
  it("pre_model can refuse the request, ending the session without calling the provider", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      { point: "pre_model", handler: () => ({ action: "deny", reason: "over budget" }) },
    ]);
    const events = await collect(session);
    await session.done;
    expect(provider.requests).toHaveLength(0);
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("over budget"))).toBe(true);
  });

  it("pre_model can replace the system prompt", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      { point: "pre_model", handler: () => ({ action: "modify", patch: { system: "REPLACED" } }) },
    ]);
    await collect(session);
    await session.done;
    expect(provider.requests[0]!.system).toBe("REPLACED");
  });

  it("pre_model append preserves existing manifest provenance and adds a hook block", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      {
        point: "pre_model",
        handler: (ctx) => ({
          action: "modify",
          patch: { system: `${(ctx as { request: { system: string } }).request.system}\n\nHOOK APPEND` },
        }),
      },
    ]);
    const events = await collect(session);
    await session.done;
    const manifest = events.find((event) => event.type === "context.manifest");
    expect(manifest).toMatchObject({ type: "context.manifest" });
    if (manifest?.type !== "context.manifest") throw new Error("missing context manifest");
    expect(manifest.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "system_prompt", origin: "agent.config.systemPrompt" }),
      expect.objectContaining({ source: "system_prompt", origin: "hook:pre_model", reason: "pre_model hook appended instructions" }),
    ]));
  });

  it("pre_model reports a patch of the wrong shape", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [{ point: "pre_model", handler: () => ({ action: "modify", patch: { messages: [] } }) }],
    );
    const events = await collect(session);
    await session.done;
    expect(
      events.some((e) => e.type === "error" && (e as { message: string }).message.includes("{ system: string }")),
    ).toBe(true);
  });

  it("post_model injects are attributed to the hook, not to the user", async () => {
    // the supervisor's reviewer grades trajectories off steer events; a hook nudge scored as a
    // human correction is a lie in the log
    const session = run(
      [callEcho("x"), [usage(1, 1), stop("end_turn")]],
      [{ point: "post_model", handler: () => ({ action: "inject", message: "hook nudge" }) }],
    );
    const events = await collect(session);
    await session.done;
    const steer = events.find((e) => e.type === "steer") as { source: string; message: string } | undefined;
    const undelivered = events.find(
      (e) => e.type === "error" && (e as { message: string }).message.includes("not delivered"),
    ) as { message: string } | undefined;
    // whichever path it took, it must not claim to be the user
    expect((steer?.source ?? "") === "user").toBe(false);
    if (undelivered !== undefined) expect(undelivered.message).toContain("from hook");
  });
});

describe("user_prompt modify", () => {
  it("the last string patch wins, and a wrong shape is reported", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = runWith(provider, [
      { point: "user_prompt", id: "a", handler: () => ({ action: "modify", patch: "first rewrite" }) },
      { point: "user_prompt", id: "b", handler: () => ({ action: "modify", patch: "second rewrite" }) },
      { point: "user_prompt", id: "c", handler: () => ({ action: "modify", patch: { wrong: "shape" } }) },
    ]);
    const events = await collect(session);
    await session.done;

    expect(modelSaw(provider)).toContain("second rewrite");
    expect(modelSaw(provider)).not.toContain("first rewrite");
    expect(
      events.some((e) => e.type === "error" && (e as { message: string }).message.includes("must be a string")),
    ).toBe(true);
  });
});

describe("session_end hooks are bounded as a group", () => {
  it("a total budget stops the chain even when each hook's own timeout is generous", async () => {
    const ran: string[] = [];
    const slow = (id: string): Hook => ({
      point: "session_end",
      id,
      timeoutMs: 10 * 60_000, // individually generous, like the real ingest hook
      handler: async () => {
        ran.push(id);
        await new Promise((r) => setTimeout(r, 300));
        return { action: "continue" };
      },
    });
    const session = createAgent({
      provider: new FakeProvider([[usage(1, 1), stop("end_turn")]]),
      tools: [echoTool()],
      permissions: new RulePolicy(defaultRules),
      systemPrompt: "test",
      store: new SessionStore({ root }),
      hooks: [slow("a"), slow("b"), slow("c")],
      // 3 x 300ms of work against a 200ms group budget: the margin is wide enough that a slow
      // CI box cannot accidentally satisfy it
      sessionEndBudgetMs: 200,
      budget: { maxTurns: 2 },
      maxTokensPerTurn: 100,
    }).run("t", { cwd: root });

    const t0 = Date.now();
    const events = await collect(session);
    await session.done;

    // without a group budget these three would have run to completion in sequence (900ms+)
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ran.length).toBeLessThan(3);
    // whichever bound bit first — the per-hook budget derived from the remainder, or the group
    // budget being exhausted — the chain must report why it stopped
    expect(
      events.some(
        (e) =>
          e.type === "error" &&
          /budget for this point is spent|did not finish within/.test((e as { message: string }).message),
      ),
    ).toBe(true);
  });

  it("a steer queued by a session_end hook is reported rather than vanishing", async () => {
    const session = run(
      [[usage(1, 1), stop("end_turn")]],
      [
        {
          point: "session_end",
          handler: () => ({ action: "continue" }),
        },
      ],
    );
    const events = await collect(session);
    await session.done;
    expect(events.at(-1)!.type).toBe("session.end");
  });
});
