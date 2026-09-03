import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  RulePolicy,
  SessionStore,
  type AgentConfig,
  type AnyTool,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

/**
 * R3c: a fork child has no snapshot until it completes a turn of its own, so before this the
 * `sessions fork` output could be replayed but never continued — `run --resume <child>` died with
 * "no snapshot found". Resume now materializes the fork's tree when no snapshot exists.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-fork-resume-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    yield* this.turns.shift() ?? [{ type: "stop" as const, reason: "end_turn" as const }];
  }
}

const usage = (i: number, o: number): ModelEvent => ({ type: "usage", usage: { input: i, output: o } });
const stop = (r: "end_turn" | "tool_use"): ModelEvent => ({ type: "stop", reason: r });

const echoTool = (): AnyTool => ({
  name: "echo",
  description: "echoes",
  inputSchema: z.object({ text: z.string() }),
  permission: "read",
  execute: async (input: { text: string }) => ({ output: input.text, display: input.text }),
});

function config(provider: ModelProvider, store: SessionStore): AgentConfig {
  return {
    provider,
    tools: [echoTool()],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    systemPrompt: "test",
    repoMap: false,
    trustedProjectRoot: root,
    store,
  };
}

async function collect(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

const hashFile = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

describe("resuming a fork", () => {
  it("continues a fork child from its materialized tree when it has no snapshot of its own", async () => {
    const ids = ["parent", "child"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    const first = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }, usage(10, 5), stop("tool_use")],
      [{ type: "text_delta", text: "parent done" }, usage(20, 3), stop("end_turn")],
    ]);
    const s1 = createAgent(config(first, store)).run("say hi", { cwd: root });
    await collect(s1);
    expect((await s1.done).reason).toBe("done");

    const child = await store.fork("parent", (await store.readAll("parent")).at(-1)!.seq);
    expect(await store.readSnapshot(child)).toBeNull();
    const parentHash = await hashFile(store.pathFor("parent"));

    const second = new FakeProvider([[{ type: "text_delta", text: "child reply" }, usage(5, 2), stop("end_turn")]]);
    const s2 = createAgent(config(second, store)).run("now say bye", { resume: child });
    const events = await collect(s2);
    const summary = await s2.done;

    // turns and usage continue from the parent's recorded state, as a snapshot resume would
    expect(summary).toMatchObject({ id: child, reason: "done", turns: 3 });
    expect(summary.usage).toMatchObject({ input: 35, output: 10 });
    expect(events[0]).toMatchObject({ type: "session.resume", task: "now say bye", cwd: root, turns: 2 });

    // the model saw the whole inherited conversation, then the new task
    const msgs = second.requests[0]!.messages;
    expect(msgs[0]!.content[0]).toMatchObject({ type: "text", text: "say hi" });
    expect(msgs.some((m) => m.content.some((b) => b.type === "tool_result" && b.toolUseId === "t1"))).toBe(true);
    expect(msgs.some((m) => m.content.some((b) => b.type === "text" && b.text === "parent done"))).toBe(true);
    expect(msgs.at(-1)!.content[0]).toMatchObject({ type: "text", text: "now say bye" });

    // the child wrote only its own log, and now has a snapshot of its own for the next resume
    expect(await hashFile(store.pathFor("parent"))).toBe(parentHash);
    expect((await store.readAll(child))[0]).toMatchObject({ type: "session.fork", parent: "parent" });
    expect(await store.readSnapshot(child)).not.toBeNull();
  });

  it("closes a tool call left open at the fork point so the resumed request is acceptable", async () => {
    const ids = ["parent", "child"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    const first = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }, usage(10, 5), stop("tool_use")],
      [{ type: "text_delta", text: "parent done" }, usage(20, 3), stop("end_turn")],
    ]);
    const s1 = createAgent(config(first, store)).run("say hi", { cwd: root });
    await collect(s1);
    await s1.done;

    // fork right after the tool.call, before its recorded result
    const call = (await store.readAll("parent")).find((e) => e.type === "tool.call")!;
    const child = await store.fork("parent", call.seq);

    const second = new FakeProvider([[{ type: "text_delta", text: "ok" }, usage(1, 1), stop("end_turn")]]);
    const s2 = createAgent(config(second, store)).run("carry on", { resume: child });
    await collect(s2);
    expect((await s2.done).reason).toBe("done");

    const msgs = second.requests[0]!.messages;
    const toolUseIndex = msgs.findIndex((m) => m.content.some((b) => b.type === "tool_use" && b.id === "t1"));
    const after = msgs[toolUseIndex + 1]!;
    expect(after.role).toBe("user");
    expect(after.content[0]).toMatchObject({ type: "tool_result", toolUseId: "t1", isError: true });
    expect(msgs.at(-1)!.content[0]).toMatchObject({ type: "text", text: "carry on" });
  });

  it("still refuses a plain session with no snapshot — materialization is for forks only", async () => {
    const store = new SessionStore({ root, newId: () => "plain" });
    await store.append("plain", { type: "session.start", task: "t", cwd: root, provider: "fake", model: "m" });
    expect(await store.materializeSnapshot("plain")).toBeNull();
    expect(await store.materializeSnapshot("never-existed")).toBeNull();

    const provider = new FakeProvider([]);
    const session = createAgent(config(provider, store)).run("more", { resume: "plain" });
    const events = await collect(session);
    expect((await session.done).reason).toBe("error");
    expect(events.some((e) => e.type === "error" && e.fatal && /no snapshot/.test(e.message))).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });
});
