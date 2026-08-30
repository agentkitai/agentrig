import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgent,
  defaultRules,
  RulePolicy,
  SessionStore,
  type AnyTool,
  type ModelEvent,
  type ModelProvider,
} from "@agentkitai/agentrig-core";
import { COMMANDS, helpText, parseCommand } from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";

describe("parseCommand", () => {
  it("treats anything not starting with / as a task", () => {
    expect(parseCommand("fix the retry logic")).toEqual({ kind: "task", text: "fix the retry logic" });
    expect(parseCommand("  spaced  ")).toEqual({ kind: "task", text: "spaced" });
  });

  it("ignores an empty line rather than spending a turn on it", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
  });

  it("parses every command it advertises in /help", () => {
    for (const spec of COMMANDS) {
      const parsed = parseCommand(`/${spec.name}`);
      expect(parsed, `/${spec.name} is listed in help but does not parse`).not.toBeNull();
      expect(parsed!.kind).not.toBe("unknown");
    }
  });

  it("takes arguments", () => {
    expect(parseCommand("/memory retry policy")).toEqual({ kind: "memory", query: "retry policy" });
    expect(parseCommand("/resume abc123")).toEqual({ kind: "resume", id: "abc123" });
    expect(parseCommand("/dream --auto")).toEqual({ kind: "dream", auto: true });
    expect(parseCommand("/dream")).toEqual({ kind: "dream", auto: false });
  });

  it("accepts the obvious aliases", () => {
    expect(parseCommand("/exit")!.kind).toBe("quit");
    expect(parseCommand("/?")!.kind).toBe("help");
    expect(parseCommand("/stop")!.kind).toBe("abort");
  });

  it("is case-insensitive on the command name but not on its arguments", () => {
    expect(parseCommand("/HELP")!.kind).toBe("help");
    expect(parseCommand("/memory RetryPolicy")).toEqual({ kind: "memory", query: "RetryPolicy" });
  });

  it("reports a typo instead of silently spending a turn on it as a prompt", () => {
    expect(parseCommand("/memroy")).toEqual({ kind: "unknown", name: "memroy" });
    expect(parseCommand("/")).toEqual({ kind: "unknown", name: "" });
  });

  it("helpText lists every command", () => {
    const text = helpText();
    for (const spec of COMMANDS) expect(text).toContain(`/${spec.name}`);
  });
});

// ---------------------------------------------------------------- controller

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

/** Declares no paths, so the cwdOnly default rule cannot cover it — it must reach `ask`. */
const askingTool = (): AnyTool => ({
  name: "needs_permission",
  description: "asks",
  inputSchema: z.object({}),
  permission: "exec",
  execute: async () => ({ output: "ran", display: "ran" }),
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-tui-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeController(turns: ModelEvent[][], extra: Partial<ConstructorParameters<typeof TuiController>[0]> = {}) {
  const controller: TuiController = new TuiController({
    cwd: root,
    agent: createAgent({
      provider: new FakeProvider(turns),
      tools: [askingTool()],
      permissions: new RulePolicy(defaultRules),
      systemPrompt: "test",
      store: new SessionStore({ root }),
      budget: { maxTurns: 5 },
      maxTokensPerTurn: 100,
      onAsk: (req) => controller.ask(req),
    }),
    ...extra,
  });
  return controller;
}

const text = (c: TuiController): string => c.snapshot().lines.map((l) => l.text).join("\n");

describe("TuiController", () => {
  it("runs a task and reports how it finished", async () => {
    const c = makeController([[usage(1, 1), stop("end_turn")]]);
    expect(await c.submit("do the thing")).toBe(true);

    expect(text(c)).toContain("do the thing");
    expect(text(c)).toContain("done after");
    expect(c.snapshot().status).toBe("idle");
    expect(c.snapshot().sessionId).not.toBeNull();
  });

  it("shows the model's reply — the whole point, and the one thing it used to drop", async () => {
    const c = makeController([
      [{ type: "text_delta", text: "Hello! " }, { type: "text_delta", text: "How can I help?" }, usage(1, 1), stop("end_turn")],
    ]);
    await c.submit("hello");

    // `model.delta` was skipped as per-token noise, and nothing else carries the text: the agent
    // answered and the user saw session.start, turn.start, model.request, turn.end, session.end
    expect(text(c)).toContain("Hello! How can I help?");
    const reply = c.snapshot().lines.find((l) => l.text.includes("How can I help?"));
    expect(reply!.tone).toBe("assistant");
  });

  it("streams the reply live, then commits it once", async () => {
    const c = makeController([[{ type: "text_delta", text: "thinking out loud" }, usage(1, 1), stop("end_turn")]]);
    await c.submit("hello");

    // the live buffer is cleared when the turn ends, or the text would appear twice
    expect(c.snapshot().streaming).toBe("");
    expect(text(c).match(/thinking out loud/g)).toHaveLength(1);
  });

  it("keeps the plumbing out of the way until /verbose asks for it", async () => {
    const c = makeController([[{ type: "text_delta", text: "hi" }, usage(1, 1), stop("end_turn")]]);
    await c.submit("hello");

    // a person asking a question does not read turn.start and model.request
    for (const noise of ["turn.start", "model.request", "model.response", "session.start"]) {
      expect(text(c), `${noise} should not be shown by default`).not.toContain(noise);
    }

    expect(await c.submit("/verbose")).toBe(true);
    expect(c.snapshot().verbose).toBe(true);
    await c.submit("again");
    expect(text(c)).toContain("model.request");
    expect(text(c)).toContain("turn.start");

    // ...and the reply is still shown in verbose mode, not replaced by the trace
    expect(text(c)).toContain("hi");
  });

  it("/verbose toggles back off", async () => {
    const c = makeController([]);
    await c.submit("/verbose");
    expect(c.snapshot().verbose).toBe(true);
    await c.submit("/verbose");
    expect(c.snapshot().verbose).toBe(false);
  });

  it("/quit is the only thing that ends the app", async () => {
    const c = makeController([]);
    expect(await c.submit("/quit")).toBe(false);
    expect(await c.submit("/help")).toBe(true);
    expect(await c.submit("anything else")).toBe(true);
  });

  it("prints help on an unknown command, so the answer is always in reach", async () => {
    const c = makeController([]);
    await c.submit("/memroy");
    expect(text(c)).toContain("unknown command /memroy");
    expect(text(c)).toContain("/memory");
  });

  it("surfaces a permission request and resolves it on the answer", async () => {
    const c = makeController([
      [{ type: "tool_use", id: "t1", name: "needs_permission", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const running = c.submit("run it");

    // the prompt has to appear before anything can answer it
    await vi.waitFor(() => expect(c.snapshot().pending).not.toBeNull());
    expect(c.snapshot().pending!.req.tool).toBe("needs_permission");

    c.answerPermission("allow");
    await running;
    expect(c.snapshot().pending).toBeNull();
    expect(text(c)).toContain("allowed needs_permission");
  });

  it("a denial reaches the loop as a denial", async () => {
    const c = makeController([
      [{ type: "tool_use", id: "t1", name: "needs_permission", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const running = c.submit("run it");
    await vi.waitFor(() => expect(c.snapshot().pending).not.toBeNull());
    c.answerPermission("deny");
    await running;
    expect(text(c)).toContain("denied needs_permission");
    // the conversation view says it plainly; the raw event name is behind /verbose
    expect(text(c)).toContain("✗ denied needs_permission");
  });

  it("refuses to start a second turn while one is running", async () => {
    const c = makeController([
      [{ type: "tool_use", id: "t1", name: "needs_permission", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const running = c.submit("first");
    // wait for the PROMPT, not merely for the status: answering before it exists would leave the
    // loop waiting forever
    await vi.waitFor(() => expect(c.snapshot().pending).not.toBeNull());

    await c.submit("second");
    expect(text(c)).toContain("a turn is already running");

    c.answerPermission("deny");
    await running;
  });

  it("/abort answers a pending prompt, so the loop is not left waiting", async () => {
    const c = makeController([
      [{ type: "tool_use", id: "t1", name: "needs_permission", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const running = c.submit("run it");
    await vi.waitFor(() => expect(c.snapshot().pending).not.toBeNull());

    await c.submit("/abort");
    await running;
    expect(c.snapshot().pending).toBeNull();
    expect(c.snapshot().status).toBe("idle");
  });

  it("/abort with nothing running says so instead of throwing", async () => {
    const c = makeController([]);
    await c.submit("/abort");
    expect(text(c)).toContain("nothing running");
  });

  it("/plan shows the plan the agent recorded", async () => {
    const c = makeController([[usage(1, 1), stop("end_turn")]]);
    await c.submit("/plan");
    expect(text(c)).toContain("no plan recorded yet");
  });

  it("/supervisor says no supervisor is attached rather than promising an empty list", async () => {
    // /help advertises the command; without a supervisor the only reachable output was "nothing
    // raised", which reads as "all clear" when the truth is "nothing is watching"
    const c = makeController([]);
    await c.submit("/supervisor");
    expect(text(c)).toContain("no supervisor is attached");
  });

  it("/supervisor reports an empty list when one IS attached", async () => {
    const c = makeController([], { supervised: true });
    await c.submit("/supervisor");
    expect(text(c)).toContain("raised nothing");
  });

  it("/memory and /dream report when they are not wired up", async () => {
    const c = makeController([]);
    await c.submit("/memory retry");
    await c.submit("/dream");
    expect(text(c)).toContain("/memory is not available");
    expect(text(c)).toContain("/dream is not available");
  });

  it("a failing side command is reported, not thrown into the render loop", async () => {
    const c = makeController([], {
      onMemory: async () => {
        throw new Error("wiki is on fire");
      },
    });
    await c.submit("/memory x");
    expect(text(c)).toContain("/memory failed: wiki is on fire");
    expect(c.snapshot().status).toBe("idle");
  });

  it("delegates /memory and prints what it returns", async () => {
    const c = makeController([], { onMemory: async (q) => [`hit for ${q}`] });
    await c.submit("/memory retry");
    expect(text(c)).toContain("hit for retry");
  });

  it("/dream passes --auto through", async () => {
    const seen: boolean[] = [];
    const c = makeController([], {
      onDream: async (auto) => {
        seen.push(auto);
        return ["ok"];
      },
    });
    await c.submit("/dream");
    await c.submit("/dream --auto");
    expect(seen).toEqual([false, true]);
  });

  it("/resume without an id explains itself rather than starting a nameless session", async () => {
    const c = makeController([]);
    await c.submit("/resume");
    expect(text(c)).toContain("usage: /resume <session-id>");
    expect(c.snapshot().sessionId).toBeNull();
  });

  it("a session that cannot start is reported, and the controller stays usable", async () => {
    const c = makeController([[usage(1, 1), stop("end_turn")]]);
    await c.submit("/resume ../escape");
    expect(text(c)).toMatch(/could not start|invalid session id|session failed/);
    expect(c.snapshot().status).toBe("idle");
    // still works afterwards
    expect(await c.submit("/help")).toBe(true);
  });

  it("bounds the line buffer so a long session cannot grow the terminal without limit", () => {
    const c = makeController([], { maxLines: 10 });
    for (let i = 0; i < 50; i += 1) c.print(`line ${i}`);
    expect(c.snapshot().lines).toHaveLength(10);
    expect(text(c)).toContain("line 49");
    expect(text(c)).not.toContain("line 0\n");
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const c = makeController([]);
    const seen: number[] = [];
    const off = c.subscribe((s) => seen.push(s.lines.length));
    c.print("one");
    off();
    c.print("two");
    // the initial call plus one update; nothing after unsubscribing
    expect(seen).toEqual([0, 1]);
  });

  it("joins per-token deltas into one line rather than one line per token", async () => {
    const c = makeController([
      [{ type: "text_delta", text: "hello " }, { type: "text_delta", text: "world" }, usage(1, 1), stop("end_turn")],
    ]);
    await c.submit("say hi");
    expect(text(c)).not.toContain("model.delta");
    // one line carrying the whole reply, not two carrying "hello " and "world"
    const replies = c.snapshot().lines.filter((l) => l.tone === "assistant");
    expect(replies.map((l) => l.text)).toEqual(["hello world"]);
  });
});

describe("review regressions", () => {
  it("the permission queue never drops a resolver", async () => {
    // a single slot overwrote the first resolver when two requests overlapped, leaving its
    // promise unsettled and the loop wedged. Latent through core today (tool calls are
    // sequential) but free to fix, and a fork bomb of a bug once they are not.
    const c = makeController([]);
    const first = c.ask({ tool: "a", input: {}, class: "exec", cwd: root });
    const second = c.ask({ tool: "b", input: {}, class: "exec", cwd: root });

    expect(c.snapshot().pending!.req.tool).toBe("a");
    expect(c.snapshot().queued).toBe(1);

    c.answerPermission("allow");
    expect(await first).toBe("allow");
    // the second is now on screen rather than lost
    expect(c.snapshot().pending!.req.tool).toBe("b");
    expect(c.snapshot().queued).toBe(0);

    c.answerPermission("deny");
    expect(await second).toBe("deny");
    expect(c.snapshot().pending).toBeNull();
  });

  it("shutdown settles every outstanding request rather than dropping it", async () => {
    const c = makeController([]);
    const pending = c.ask({ tool: "a", input: {}, class: "exec", cwd: root });
    const queued = c.ask({ tool: "b", input: {}, class: "exec", cwd: root });
    await c.shutdown();
    // both resolve: an unsettled resolver is a loop that can never finish
    expect(await pending).toBe("deny");
    expect(await queued).toBe("deny");
  });

  it("/quit stops a running turn instead of abandoning it", async () => {
    // the UI unmounting while the agent runs on means it keeps executing tools and billing with
    // nobody watching
    const c = makeController([
      [{ type: "tool_use", id: "t1", name: "needs_permission", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const running = c.submit("start something");
    await vi.waitFor(() => expect(c.snapshot().pending).not.toBeNull());

    expect(await c.submit("/quit")).toBe(false);
    await running;
    expect(c.snapshot().status).toBe("idle");
    expect(c.snapshot().pending).toBeNull();
  });

  it("line keys stay unique across truncation, so React cannot reuse a row", () => {
    const c = makeController([], { maxLines: 10 });
    for (let i = 0; i < 50; i += 1) c.print(`line ${i}`);
    const keys = c.snapshot().lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
