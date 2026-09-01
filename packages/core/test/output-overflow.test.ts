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

function expectNoUnpairedSurrogates(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      expect(text.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xDC00);
      expect(text.charCodeAt(index + 1)).toBeLessThanOrEqual(0xDFFF);
      index += 1;
    } else {
      expect(code < 0xDC00 || code > 0xDFFF).toBe(true);
    }
  }
}

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
      expectNoUnpairedSurrogates(display);
      expect(display).not.toContain("HIDDEN");
      expect(display).toContain("read_output");
      const handle = /cursor (\d+) of \d+ UTF-16 code units; read next with read_output \{"seq":(\d+),"from":(\d+),"to":(\d+)\}/.exec(display);
      const visible = Number(handle?.[1]);
      const seq = Number(handle?.[2]);
      expect(Number.isSafeInteger(seq)).toBe(true);
      expect(Number(handle?.[3])).toBe(visible);
      yield {
        type: "tool_use",
        id: "read-1",
        name: "read_output",
        input: { seq, from: visible, to: this.fullOutput.length },
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
          displayPrefixChars: 30_000,
        }
      : { output, display: output },
  };
}

function config(
  provider: ModelProvider,
  store: SessionStore,
  tools: AnyTool[],
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    provider,
    store,
    tools,
    permissions: new RulePolicy(defaultRules),
    systemPrompt: "test",
    repoMap: false,
    trustedProjectRoot: root,
    now: (() => { let now = 1_000; return () => now++; })(),
    ...overrides,
  };
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const collected: HarnessEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("output overflow artifacts", () => {
  it("stores oversized output in the immutable log and reads a hidden range without rerunning the tool", async () => {
    const fullOutput = `${"😀".repeat(15_500)}HIDDEN`;
    const provider = new OverflowProvider(fullOutput);
    const store = new SessionStore({ root, newId: () => "overflow-session" });
    const forgotToBound: AnyTool = {
      ...largeTool("unused"),
      execute: async () => ({ output: { structured: true }, display: fullOutput }),
    };
    const session = createAgent(config(provider, store, [forgotToBound])).run("inspect output", { cwd: root });
    const events = await collect(session.events);
    const summary = await session.done;
    expect(summary.reason).toBe("done");

    const largeResult = events.find((event) => event.type === "tool.result" && event.id === "large-1");
    expect(largeResult).toMatchObject({
      type: "tool.result",
      truncated: true,
      output: fullOutput,
    });
    if (largeResult?.type !== "tool.result") throw new Error("missing large result");
    expect(largeResult.display.length).toBeLessThanOrEqual(30_000);
    const truncation = /\n… \[truncated (\d+) UTF-16 code units\]$/.exec(largeResult.display);
    expect(Number(truncation?.[1]) + (truncation?.index ?? Infinity)).toBe(fullOutput.length);
    expect(events.some(
      (event) => event.type === "tool.result.patched" && event.id === "large-1" && event.by === "core:output-overflow",
    )).toBe(true);
    expect(events.filter((event) => event.type === "tool.call" && event.name === "large_output")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.call" && event.name === "read_output")).toBe(true);
    expect(events.find((event) => event.type === "tool.result" && event.id === "read-1")).toMatchObject({
      display: expect.stringMatching(/HIDDEN$/),
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
    expect(tool.description).toContain("no extra permission is required");
    expect(tool.inputSchema.safeParse({ seq: 1, from: 2, to: 2 }).error?.message).toContain("to must be greater");
    expect(tool.inputSchema.safeParse({ seq: 1, from: 0, to: 30_001 }).error?.message).toContain(
      "at most 30000 UTF-16 code units",
    );
    expect(tool.inputSchema.safeParse({ seq: 1, from: 0, to: 30_000 }).success).toBe(true);
  });

  it("does not advertise read_output in a tool-free agent", async () => {
    let advertised: string[] | undefined;
    const provider: ModelProvider = {
      id: "tool-free-fake",
      model: "tool-free-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        advertised = req.tools.map((tool) => tool.name);
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const session = createAgent(config(provider, new SessionStore({ root }), [])).run("answer only", { cwd: root });
    await collect(session.events);
    await session.done;
    expect(advertised).toEqual([]);
  });

  it("streams to the requested event and rejects invalid runtime and surrogate-splitting bounds", async () => {
    class StreamingOnlyStore extends SessionStore {
      override readAll(): Promise<HarnessEvent[]> {
        throw new Error("readAll must not be used by read_output");
      }
    }
    const store = new StreamingOnlyStore({ root, now: () => 1_000 });
    await store.append("session-a", {
      type: "tool.result", id: "unicode", ok: true, display: "partial", durationMs: 1,
      output: "a😀b", truncated: true,
    });
    const tool = readOutputTool(store);
    const ctx = { cwd: root, sessionId: "session-a", emit: () => {}, signal: new AbortController().signal };

    await expect(tool.execute({ seq: 0, from: 4, to: 5 }, ctx)).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ seq: 0, from: 0, to: 5 }, ctx)).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ seq: 0, from: 2, to: 4 }, ctx)).resolves.toMatchObject({
      isError: true,
      display: expect.stringContaining("set `from` to 1"),
    });
    await expect(tool.execute({ seq: 0, from: 0, to: 2 }, ctx)).resolves.toMatchObject({
      isError: true,
      display: expect.stringContaining("set `to` to 1"),
    });
    await expect(tool.execute({ seq: 0, from: 1, to: 3 }, ctx)).resolves.toMatchObject({ display: "😀" });
  });

  it("seals an overflow artifact when a post-tool hook has rewritten its display", async () => {
    const fullOutput = `${"s".repeat(31_000)}SECRET`;
    const provider: ModelProvider = {
      id: "redaction-fake",
      model: "redaction-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        if (!req.messages.some((message) => message.content.some((block) => block.type === "tool_result"))) {
          yield { type: "tool_use", id: "secret", name: "large_output", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        const transcript = req.messages.map((message) => textOf(message.content)).join("\n");
        expect(transcript).toContain("[REDACTED]");
        expect(transcript).not.toContain("read_output");
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const store = new SessionStore({ root, newId: () => "redacted-session" });
    const session = createAgent(config(provider, store, [largeTool(fullOutput)], {
      hooks: [{ point: "post_tool", handler: () => ({ action: "modify", patch: "[REDACTED]" }) }],
    })).run("go", { cwd: root });
    const events = await collect(session.events);
    await session.done;
    const artifact = events.find((event) => event.type === "tool.result" && event.id === "secret");
    if (artifact?.type !== "tool.result") throw new Error("missing artifact");
    const result = await readOutputTool(store).execute(
      { seq: artifact.seq, from: 31_000, to: 31_006 },
      { cwd: root, sessionId: "redacted-session", emit: () => {}, signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      isError: true,
      display: expect.stringContaining("post_tool hook sealed this artifact"),
    });
    expect(result.display).not.toContain("SECRET");
  });

  it("preserves injected guidance alongside an overflow handle and leaves the artifact readable", async () => {
    const fullOutput = "x".repeat(31_000);
    const provider: ModelProvider = {
      id: "inject-fake", model: "inject-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        if (!req.messages.some((message) => message.content.some((block) => block.type === "tool_result"))) {
          yield { type: "tool_use", id: "inject-1", name: "large_output", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        const transcript = req.messages.map((message) => textOf(message.content)).join("\n");
        expect(transcript).toContain("GUIDANCE");
        expect(transcript).toContain("read_output");
        const result = req.messages.flatMap((message) => message.content)
          .find((block) => block.type === "tool_result" && block.toolUseId === "inject-1");
        expect(result?.type === "tool_result" && typeof result.content === "string" ? result.content.length : Infinity)
          .toBeLessThanOrEqual(30_000);
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const store = new SessionStore({ root, newId: () => "inject-session" });
    const session = createAgent(config(provider, store, [largeTool(fullOutput)], {
      hooks: [{ point: "post_tool", handler: () => ({ action: "inject", message: "GUIDANCE" }) }],
    })).run("go", { cwd: root });
    const events = await collect(session.events);
    expect((await session.done).reason).toBe("done");
    const artifact = events.find((event) => event.type === "tool.result" && event.id === "inject-1");
    if (artifact?.type !== "tool.result") throw new Error("missing artifact");
    await expect(readOutputTool(store).execute(
      { seq: artifact.seq, from: 30_999, to: 31_000 },
      { cwd: root, sessionId: "inject-session", emit: () => {}, signal: new AbortController().signal },
    )).resolves.toMatchObject({ display: "x" });
  });

  it("keeps an artifact readable after an inject-only post-tool patch", async () => {
    const store = new SessionStore({ root, now: () => 1_000 });
    await store.append("session-a", {
      type: "tool.result", id: "base", ok: true, display: "partial", durationMs: 1,
      output: "complete output", truncated: true,
    });
    await store.append("session-a", {
      type: "tool.result.patched", id: "base", by: "post_tool", display: "partial\nguidance", mode: "inject",
    });
    await expect(readOutputTool(store).execute(
      { seq: 0, from: 0, to: 8 },
      { cwd: root, sessionId: "session-a", emit: () => {}, signal: new AbortController().signal },
    )).resolves.toMatchObject({ display: "complete" });
  });

  it("bounds a thrown tool error before persisting or sending it", async () => {
    const provider: ModelProvider = {
      id: "throwing-fake",
      model: "throwing-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        if (!req.messages.some((message) => message.content.some((block) => block.type === "tool_result"))) {
          yield { type: "tool_use", id: "throw-1", name: "throwing", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        const result = req.messages.flatMap((message) => message.content)
          .find((block) => block.type === "tool_result" && block.toolUseId === "throw-1");
        expect(result?.type === "tool_result" && typeof result.content === "string" ? result.content.length : Infinity)
          .toBeLessThan(31_000);
        expect(textOf(req.messages.flatMap((message) => message.content))).not.toContain("TAIL");
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const throwing: AnyTool = {
      ...largeTool("unused"),
      name: "throwing",
      execute: async () => { throw new Error(`${"e".repeat(40_000)}TAIL`); },
    };
    const session = createAgent(config(provider, new SessionStore({ root }), [throwing])).run("go", { cwd: root });
    const events = await collect(session.events);
    await session.done;
    const result = events.find((event) => event.type === "tool.result" && event.id === "throw-1");
    expect(result?.type === "tool.result" ? result.display.length : Infinity).toBeLessThanOrEqual(30_000);
    expect(result).toMatchObject({ type: "tool.result", truncated: true, output: expect.stringMatching(/TAIL$/) });
    expect(result?.type === "tool.result" ? result.display : "").not.toContain("TAIL");
  });

  it("creates an artifact when a tool-specific preview truncates below the global cap", async () => {
    const full = "q".repeat(25_000);
    const provider: ModelProvider = {
      id: "sub-cap-fake", model: "sub-cap-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        const prior = req.messages.flatMap((message) => message.content)
          .find((block) => block.type === "tool_result" && block.toolUseId === "sub-cap-1");
        if (prior === undefined) {
          yield { type: "tool_use", id: "sub-cap-1", name: "sub_cap", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        const display = prior.type === "tool_result" && typeof prior.content === "string" ? prior.content : "";
        expect(display.length).toBeLessThanOrEqual(30_000);
        expect(display).toContain("read_output");
        expect(display).toContain('"from":');
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const subCap: AnyTool = {
      ...largeTool("unused"), name: "sub_cap",
      execute: async () => ({
        output: {}, display: `${full.slice(0, 20_000)}\n… local truncation`, truncated: true,
        fullDisplay: full, displayPrefixChars: 20_000,
      }),
    };
    const session = createAgent(config(provider, new SessionStore({ root }), [subCap])).run("go", { cwd: root });
    await collect(session.events);
    expect((await session.done).reason).toBe("done");
  });

  it("keeps a non-prefix preview while paging complete output from cursor zero", async () => {
    const provider: ModelProvider = {
      id: "header-fake",
      model: "header-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        const prior = req.messages.flatMap((message) => message.content)
          .find((block) => block.type === "tool_result" && block.toolUseId === "header-1");
        if (prior === undefined) {
          yield { type: "tool_use", id: "header-1", name: "header", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        const display = prior.type === "tool_result" && typeof prior.content === "string" ? prior.content : "";
        expect(display).toContain("10 matches found");
        expect(display).toContain('"from":0');
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const header: AnyTool = {
      ...largeTool("unused"), name: "header",
      execute: async () => ({
        output: {}, display: "10 matches found\n… truncated", truncated: true,
        fullDisplay: "first complete match\nsecond complete match",
      }),
    };
    const session = createAgent(config(provider, new SessionStore({ root }), [header])).run("go", { cwd: root });
    await collect(session.events);
    expect((await session.done).reason).toBe("done");
  });

  it("ignores an empty fullDisplay from a malformed tool result", async () => {
    const provider: ModelProvider = {
      id: "malformed-fake",
      model: "malformed-fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      stream: async function* (req): AsyncIterable<ModelEvent> {
        if (!req.messages.some((message) => message.content.some((block) => block.type === "tool_result"))) {
          yield { type: "tool_use", id: "malformed-1", name: "malformed", input: {} };
          yield { type: "stop", reason: "tool_use" };
          return;
        }
        expect(req.messages.map((message) => textOf(message.content)).join("\n")).not.toContain("read_output");
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const malformed: AnyTool = {
      ...largeTool("preview"),
      name: "malformed",
      execute: async () => ({ output: {}, display: "preview", truncated: true, fullDisplay: "" }),
    };
    const session = createAgent(config(provider, new SessionStore({ root }), [malformed])).run("go", { cwd: root });
    const events = await collect(session.events);
    await session.done;
    expect(events.find((event) => event.type === "tool.result" && event.id === "malformed-1")).not.toHaveProperty("output");
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
