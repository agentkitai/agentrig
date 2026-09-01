import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  defaultRules,
  readOutputTool,
  RulePolicy,
  SessionStore,
  type AgentConfig,
  type AnyTool,
  type ContentBlock,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

function textOf(blocks: ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_result") return typeof block.content === "string" ? block.content : textOf(block.content);
    return "";
  }).join("\n");
}

class OverflowProvider implements ModelProvider {
  readonly id = "overflow-fake";
  readonly model = "overflow-fake-1";
  readonly capabilities = { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 };
  readonly requests: ModelRequest[] = [];
  private turn = 0;

  constructor(private readonly fullOutput: string) {}

  async *stream(req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    this.turn += 1;
    if (this.turn === 1) {
      yield { type: "tool_use", id: "large-1", name: "large_output", input: {} };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    if (this.turn === 2) {
      const prior = req.messages.flatMap((message) => message.content).find(
        (block) => block.type === "tool_result" && block.toolUseId === "large-1",
      );
      expect(prior?.type).toBe("tool_result");
      const display = prior?.type === "tool_result"
        ? (typeof prior.content === "string" ? prior.content : textOf(prior.content))
        : "";
      expect(display.length).toBeLessThanOrEqual(30_000);
      expect(display).not.toContain("HIDDEN");
      expect(display).toContain("read_output");
      const seq = Number(/"seq":(\d+)/.exec(display)?.[1]);
      expect(Number.isSafeInteger(seq)).toBe(true);
      yield {
        type: "tool_use",
        id: "read-1",
        name: "read_output",
        input: { seq, from: this.fullOutput.length - 6, to: this.fullOutput.length },
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }

    const transcript = req.messages.map((message) => textOf(message.content)).join("\n");
    expect(transcript).toContain("HIDDEN");
    yield { type: "text_delta", text: "done" };
    yield { type: "stop", reason: "end_turn" };
  }
}

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-output-overflow-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function largeTool(output: string): AnyTool {
  return {
    name: "large_output",
    description: "Return a large fixture output",
    inputSchema: z.object({}),
    permission: "read",
    paths: () => ["."],
    execute: async () => output.length > 30_000
      ? {
          output,
          display: `${output.slice(0, 30_000)}\n… [truncated ${output.length - 30_000} chars]`,
          truncated: true,
          fullDisplay: output,
        }
      : { output, display: output },
  };
}

function config(provider: ModelProvider, store: SessionStore, tools: AnyTool[]): AgentConfig {
  return {
    provider,
    store,
    tools,
    permissions: new RulePolicy(defaultRules),
    systemPrompt: "test",
    repoMap: false,
    trustedProjectRoot: root,
    now: (() => { let now = 1_000; return () => now++; })(),
  };
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const collected: HarnessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("output overflow artifacts", () => {
  it("stores oversized output in the immutable log and reads a hidden range without rerunning the tool", async () => {
    const fullOutput = `${"x".repeat(31_000)}HIDDEN`;
    const provider = new OverflowProvider(fullOutput);
    const store = new SessionStore({ root, newId: () => "overflow-session" });
    const session = createAgent(config(provider, store, [largeTool(fullOutput)])).run("inspect output", { cwd: root });
    const events = await collect(session.events);
    await session.done;

    const largeResult = events.find((event) => event.type === "tool.result" && event.id === "large-1");
    expect(largeResult).toMatchObject({
      type: "tool.result",
      truncated: true,
      output: fullOutput,
    });
    expect(events.filter((event) => event.type === "tool.call" && event.name === "large_output")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.call" && event.name === "read_output")).toBe(true);
    expect(events.find((event) => event.type === "tool.result" && event.id === "read-1")).toMatchObject({
      display: "HIDDEN",
    });

    const persisted = await store.readAll("overflow-session");
    expect(persisted.find((event) => event.seq === largeResult?.seq)).toMatchObject({ output: fullOutput });
  });

  it("does not create an artifact or alter the model display for output within the bound", async () => {
    const provider: ModelProvider = {
      id: "small-fake",
      model: "small-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        const hasResult = req.messages.some((message) => message.content.some((block) => block.type === "tool_result"));
        if (!hasResult) {
          yield { type: "tool_use", id: "small-1", name: "large_output", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        const transcript = req.messages.map((message) => textOf(message.content)).join("\n");
        expect(transcript).toContain("small output");
        expect(transcript).not.toContain("read_output");
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const store = new SessionStore({ root, newId: () => "small-session" });
    const session = createAgent(config(provider, store, [largeTool("small output")])).run("inspect output", { cwd: root });
    const events = await collect(session.events);
    await session.done;

    const result = events.find((event) => event.type === "tool.result" && event.id === "small-1");
    expect(result).not.toHaveProperty("output");
    expect(result).not.toHaveProperty("truncated");
  });

  it("rejects empty and over-bound ranges at the tool input boundary", () => {
    const tool = readOutputTool(new SessionStore({ root }));
    expect(tool.inputSchema.safeParse({ seq: 1, from: 2, to: 2 }).error?.message).toContain("to must be greater");
    expect(tool.inputSchema.safeParse({ seq: 1, from: 0, to: 30_001 }).error?.message).toContain(
      "at most 30000 UTF-16 code units",
    );
    expect(tool.inputSchema.safeParse({ seq: 1, from: 0, to: 30_000 }).success).toBe(true);
  });

  it("does not let an artifact handle cross the current session boundary", async () => {
    const store = new SessionStore({ root, now: () => 1_000 });
    await store.append("session-a", {
      type: "tool.result",
      id: "secret",
      ok: true,
      display: "partial",
      durationMs: 1,
      output: "secret hidden output",
      truncated: true,
    });
    await store.append("session-b", { type: "turn.start", n: 1 });
    const tool = readOutputTool(store);
    const result = await tool.execute(
      { seq: 0, from: 0, to: 6 },
      { cwd: root, sessionId: "session-b", emit: () => {}, signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(result.display).toContain("use the seq from a truncated tool result");
    expect(result.display).not.toContain("secret hidden output");
  });

  it("reserves read_output so a caller cannot shadow access to logged artifacts", () => {
    expect(() => createAgent(config(
      new OverflowProvider("unused"),
      new SessionStore({ root }),
      [{ ...largeTool("unused"), name: "read_output" }],
    ))).toThrow(/read_output is reserved/);
  });
});
