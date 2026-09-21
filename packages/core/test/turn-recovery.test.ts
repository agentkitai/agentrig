import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgent, RulePolicy, SessionStore, HarnessEvent, type ModelProvider, type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";
import { renderEvent, renderChatEvent } from "../../cli/src/render.js";

async function run(pattern: boolean[]) {
  const root = await mkdtemp(join(tmpdir(), "turn-recovery-"));
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(req): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(req));
      const fail = pattern.shift();
      if (fail) {
        yield { type: "text_delta", text: "discard me" };
        yield { type: "text_delta", text: " too" };
        yield { type: "tool_use", id: "discarded", name: "missing", input: {} };
        throw new Error("terminated");
      }
      yield { type: "text_delta", text: "complete" };
      yield { type: "usage", usage: { input: 1, output: 1 } };
      if (pattern.length) yield { type: "tool_use", id: "continue", name: "missing", input: {} };
      yield { type: "stop", reason: pattern.length ? "tool_use" : "end_turn" };
    },
  };
  try {
    const store = new SessionStore({ root });
    const session = createAgent({ provider, tools: [], permissions: new RulePolicy([]), systemPrompt: "test", repoMap: false,
      store, budget: { maxTurns: 10 },
    }).run("test", { cwd: root });
    const events: HarnessEvent[] = [];
    for await (const e of session.events) events.push(e);
    const summary = await session.done;
    expect(await store.readAll(summary.id)).toEqual(events);
    return { events, summary, requests };
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("discards a disconnected assistant turn and retries the same history once", async () => {
  const { events, summary, requests } = await run([true, false]);
  expect(summary.reason).toBe("done");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  const aborted = events.find(e => e.type === "turn.aborted")!;
  expect(HarnessEvent.safeParse(aborted).success).toBe(true);
  expect(renderEvent(aborted)).toContain("terminated");
  expect(renderChatEvent(aborted)).toContain("Partial response discarded");
  expect(events.findIndex(e => e.type === "turn.aborted")).toBeLessThan(
    events.findIndex(e => e.type === "turn.end"));
  expect(events.filter(e => e.type === "message.append" && e.message.role === "assistant"))
    .toMatchObject([{ message: { content: [{ type: "text", text: "complete" }] } }]);
  expect(JSON.stringify(events.filter(e => e.type === "message.append"))).not.toContain("discard");
  expect(events.filter(e => e.type === "tool.start")).toHaveLength(0);
  expect(events.filter(e => e.type === "model.retry")).toHaveLength(1);
});
it("a second disconnect in one turn remains fatal", async () => {
  const { events, summary, requests } = await run([true, true]);
  expect(summary.reason).toBe("error");
  expect(requests).toHaveLength(2);
  expect(events.filter(e => e.type === "turn.aborted")).toHaveLength(2);
});
it("the session recovery cap ends repeated disconnected turns fatally", async () => {
  const { events, summary, requests } = await run([true, false, true, false, true, false, true, false]);
  expect(summary.reason).toBe("error");
  expect(requests).toHaveLength(7);
  expect(events.filter(e => e.type === "model.retry")).toHaveLength(3);
});
