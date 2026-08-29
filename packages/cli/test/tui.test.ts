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
    expect(text(c)).toContain("tool.denied");
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

  it("/supervisor says plainly when nothing has been signalled", async () => {
    const c = makeController([]);
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

  it("does not render per-token deltas as their own lines", async () => {
    const c = makeController([
      [{ type: "text_delta", text: "hello " }, { type: "text_delta", text: "world" }, usage(1, 1), stop("end_turn")],
    ]);
    await c.submit("say hi");
    expect(text(c)).not.toContain("model.delta");
  });
});
