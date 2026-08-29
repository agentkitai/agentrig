import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  RulePolicy,
  SessionStore,
  toToolSpec,
  type AgentConfig,
  type AnyTool,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

/** Scripted provider: each run() turn consumes the next ModelEvent[] — no network anywhere. */
class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error("FakeProvider: no scripted turn left");
    yield* turn;
  }
}

const echoTool = (): AnyTool => ({
  name: "echo",
  description: "echo text back",
  inputSchema: z.object({ text: z.string() }),
  permission: "read",
  execute: async (input: { text: string }) => ({ output: input.text, display: `echo: ${input.text}` }),
});

const usage = (input: number, output: number): ModelEvent => ({ type: "usage", usage: { input, output } });
const stop = (reason: "end_turn" | "tool_use" | "max_tokens" | "error"): ModelEvent => ({ type: "stop", reason });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-agent-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeConfig(provider: ModelProvider, overrides: Partial<AgentConfig> = {}): AgentConfig {
  let t = 1000;
  return {
    provider,
    tools: [echoTool()],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    systemPrompt: "test system",
    store: new SessionStore({ root, now: () => t, newId: () => "sess1" }),
    now: () => t++,
    ...overrides,
  };
}

async function collect(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

describe("agent loop", () => {
  it("runs a tool turn then finishes, with every event in the session store", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "let me " },
        { type: "text_delta", text: "check" },
        { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
        usage(10, 5),
        stop("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, usage(20, 3), stop("end_turn")],
    ]);
    const config = makeConfig(provider);
    const session = createAgent(config).run("say hi", { cwd: "/w" });
    const events = await collect(session);
    const summary = await session.done;

    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "turn.start",
      "model.request",
      "model.delta",
      "model.delta",
      "model.response",
      "permission.request",
      "permission.decision",
      "tool.call",
      "tool.result",
      "turn.end",
      "turn.start",
      "model.request",
      "model.delta",
      "model.response",
      "turn.end",
      "session.end",
    ]);
    expect(events[0]).toMatchObject({ task: "say hi", provider: "fake", model: "fake-1", cwd: "/w" });
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ id: "t1", ok: true, display: "echo: hi" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
    expect(summary).toMatchObject({ id: "sess1", reason: "done", turns: 2, usage: { input: 30, output: 8 } });

    // the store is the source of truth: the log replays identically to what subscribers saw
    expect(await config.store.readAll("sess1")).toEqual(events);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    // the second model request carries the assistant tool_use and our tool_result back
    expect(provider.requests[1]!.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "say hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "echo: hi" }] },
    ]);
    expect(provider.requests[0]!.system).toBe("test system");
  });

  it("denies by policy: tool.denied event, error tool_result to the model", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = createAgent(
      makeConfig(provider, { permissions: new RulePolicy([{ tool: "echo", decision: "deny" }]) }),
    ).run("t");
    const events = await collect(session);

    expect(events.some((e) => e.type === "tool.denied" && e.name === "echo")).toBe(true);
    expect(events.some((e) => e.type === "tool.call")).toBe(false);
    expect(provider.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "t1",
      isError: true,
    });
    expect((await session.done).reason).toBe("done");
  });

  it("resolves ask through onAsk, defaulting to deny headless", async () => {
    const script = (): ModelEvent[][] => [
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ];
    const askPolicy = new RulePolicy([]); // everything falls through to ask

    const headless = createAgent(makeConfig(new FakeProvider(script()), { permissions: askPolicy })).run("t");
    const headlessEvents = await collect(headless);
    const decisions = headlessEvents.filter((e) => e.type === "permission.decision").map((e) => e.d);
    expect(decisions).toEqual(["ask", "deny"]);
    expect(headlessEvents.some((e) => e.type === "tool.denied")).toBe(true);

    const interactive = createAgent(
      makeConfig(new FakeProvider(script()), { permissions: askPolicy, onAsk: async () => "allow" }),
    ).run("t");
    const interactiveEvents = await collect(interactive);
    expect(interactiveEvents.filter((e) => e.type === "permission.decision").map((e) => e.d)).toEqual([
      "ask",
      "allow",
    ]);
    expect(interactiveEvents.some((e) => e.type === "tool.result" && e.ok)).toBe(true);
  });

  it("enforces the turn budget", async () => {
    const alwaysToolUse = Array.from({ length: 5 }, (): ModelEvent[] => [
      { type: "tool_use", id: "t", name: "echo", input: { text: "x" } },
      usage(1, 1),
      stop("tool_use"),
    ]);
    const session = createAgent(makeConfig(new FakeProvider(alwaysToolUse), { budget: { maxTurns: 2 } })).run("t");
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("budget");
    expect(summary.turns).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "budget" });
    expect(events.some((e) => e.type === "error" && !e.fatal && /turn budget/.test(e.message))).toBe(true);
  });

  it("enforces the token budget", async () => {
    const alwaysToolUse = Array.from({ length: 5 }, (): ModelEvent[] => [
      { type: "tool_use", id: "t", name: "echo", input: { text: "x" } },
      usage(600, 100),
      stop("tool_use"),
    ]);
    const session = createAgent(makeConfig(new FakeProvider(alwaysToolUse), { budget: { maxTokens: 1000 } })).run("t");
    await collect(session);
    const summary = await session.done;
    expect(summary.reason).toBe("budget");
    expect(summary.turns).toBe(2); // 700 tokens after turn 1 < 1000; 1400 after turn 2 trips it
  });

  it("surfaces provider failures as a fatal error and ends the session", async () => {
    const provider: ModelProvider = {
      id: "boom",
      model: "boom-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1000 },
      async *stream(): AsyncIterable<ModelEvent> {
        throw new Error("connection refused");
      },
    };
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("error");
    expect(events.some((e) => e.type === "error" && e.fatal && /connection refused/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "error" });
  });

  it("reports unknown tools and invalid input back to the model without executing", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_use", id: "t1", name: "missing", input: {} },
        { type: "tool_use", id: "t2", name: "echo", input: { wrong: 1 } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);

    const results = events.filter((e) => e.type === "tool.result");
    expect(results).toMatchObject([
      { id: "t1", ok: false, display: "unknown tool: missing" },
      { id: "t2", ok: false },
    ]);
    expect(results[1]!.display).toContain("invalid input");
    const fedBack = provider.requests[1]!.messages.at(-1)!.content;
    expect(fedBack).toMatchObject([
      { type: "tool_result", toolUseId: "t1", isError: true },
      { type: "tool_result", toolUseId: "t2", isError: true },
    ]);
  });

  it("injects steer messages at the next turn boundary", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", text: "ok" }, usage(1, 1), stop("end_turn")]]);
    const session = createAgent(makeConfig(provider)).run("t");
    session.control.steer("also check the README");
    const events = await collect(session);

    expect(events.some((e) => e.type === "steer" && e.message === "also check the README")).toBe(true);
    expect(provider.requests[0]!.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "t" }] },
      { role: "user", content: [{ type: "text", text: "also check the README" }] },
    ]);
  });

  it("abort ends the session with reason aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: ModelProvider = {
      id: "slow",
      model: "slow-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1000 },
      async *stream(_req, signal): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", text: "thinking" };
        await gate;
        if (signal.aborted) throw new Error("aborted");
        yield stop("end_turn");
      },
    };
    const session = createAgent(makeConfig(provider)).run("t");
    setTimeout(() => {
      session.control.abort();
      release();
    }, 10);
    await collect(session);
    expect((await session.done).reason).toBe("aborted");
  });
});

describe("toToolSpec", () => {
  it("derives a JSON Schema object from the zod schema", () => {
    const spec = toToolSpec(echoTool());
    expect(spec.name).toBe("echo");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(spec.inputSchema.$schema).toBeUndefined();
  });
});
