import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgent, RulePolicy, SessionStore, HarnessEvent, type ModelProvider, type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";
import { renderEvent, renderChatEvent } from "../../cli/src/render.js";

async function run(pattern: boolean[], emptyReply = false, exhaustBudget = false, preDelta = false) {
  let time = 0;
  const root = await mkdtemp(join(tmpdir(), "turn-recovery-"));
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(req): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(req));
      const fail = pattern.shift();
      if (fail) {
        if (preDelta) throw new Error("terminated");
        yield { type: "text_delta", text: "discard me" };
        yield { type: "text_delta", text: " too" };
        yield { type: "tool_use", id: "discarded", name: "missing", input: {} };
        if (exhaustBudget) time = 60_001;
        throw new Error("terminated");
      }
      if (!emptyReply) yield { type: "text_delta", text: "complete" };
      yield { type: "usage", usage: { input: 1, output: 1 } };
      if (pattern.length) yield { type: "tool_use", id: "continue", name: "missing", input: {} };
      yield { type: "stop", reason: pattern.length ? "tool_use" : "end_turn" };
    },
  };
  try {
    const store = new SessionStore({ root });
    const session = createAgent({ provider, tools: [], permissions: new RulePolicy([]), systemPrompt: "test", repoMap: false,
      store, budget: { maxTurns: 10, ...(exhaustBudget ? { maxMinutes: 1 } : {}) }, now: () => time,
    }).run("test", { cwd: root });
    const events: HarnessEvent[] = [];
    for await (const e of session.events) events.push(e);
    const summary = await session.done;
    expect(await store.readAll(summary.id)).toEqual(events);
    const fork = await store.fork(summary.id, events.at(-1)!.seq);
    const forkSnapshot = await store.materializeSnapshot(fork);
    return { events, summary, requests, forkSnapshot, messages: await store.materializeMessages(summary.id) };
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
  expect(events.filter(e => e.type === "turn.aborted")).toHaveLength(1);
});
it("the session recovery cap ends repeated disconnected turns fatally", async () => {
  const { events, summary, requests } = await run([true, false, true, false, true, false, true, false]);
  expect(summary.reason).toBe("error");
  expect(requests).toHaveLength(7);
  expect(events.filter(e => e.type === "turn.end")).toHaveLength(summary.turns);
  expect(events.filter(e => e.type === "model.retry")).toHaveLength(3);
  expectFatalWindow(events);
});

it("empty successful recovery never materializes the discarded assistant prefix", async () => {
  const { events, messages, summary } = await run([true, false], true);
  expect(summary.reason).toBe("done");
  expect(events.filter(e => e.type === "message.append" && e.message.role === "assistant")).toHaveLength(0);
  expect(messages.filter(message => message.role === "assistant")).toHaveLength(0);
  expect(JSON.stringify(messages)).not.toContain("discard me");
});

// The recovery allowance is distinct from the ordinary session budget.
it("ends the turn before fatal session end when recovery budget is exhausted", async () => {
  const { events, summary, requests } = await run([true, true]);
  expect(summary.reason).toBe("error");
  expect(requests).toHaveLength(2);
  expect(events.filter(e => e.type === "turn.aborted" || e.type === "turn.end" || e.type === "session.end")
    .map(e => e.type)).toEqual(["turn.aborted", "turn.end", "session.end"]);
  expect(events.filter(e => e.type === "turn.end")).toMatchObject([{ n: 1 }]);
  expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "error" });
  expect(events.filter(e => e.type === "error")).toMatchObject([{ message: "terminated", fatal: true }]);
  expectFatalWindow(events);
});

it("ends the turn on ordinary budget exhaustion during a failed stream without retrying", async () => {
  const { events, summary, requests } = await run([true], false, true);
  expect(summary.reason).toBe("budget");
  expect(requests).toHaveLength(1);
  expect(events.filter(e => e.type === "turn.aborted" || e.type === "turn.end" || e.type === "session.end")
    .map(e => e.type)).toEqual(["turn.end", "session.end"]);
  expect(events.filter(e => e.type === "turn.end")).toMatchObject([{ n: 1 }]);
  expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "budget" });
});

function expectFatalWindow(events: HarnessEvent[]) {
  expect(events.filter(e => e.type === "error" && e.fatal))
    .toMatchObject([{ message: "terminated", fatal: true }]);
  expect(events.slice(-4)).toMatchObject([
    { type: "error", message: "terminated", fatal: true },
    { type: "turn.end" },
    { type: "session.finishing" },
    { type: "session.end", reason: "error" },
  ]);
}

it("balances a pre-delta provider failure and preserves fork turn accounting", async () => {
  const { events, summary, requests, forkSnapshot } = await run([true], false, false, true);
  expect(summary.reason).toBe("error");
  expect(summary.turns).toBe(1);
  expect(requests).toHaveLength(1);
  expect(events.filter(e => e.type === "turn.start")).toMatchObject([{ n: 1 }]);
  expect(events.filter(e => e.type === "turn.end")).toMatchObject([{ n: 1 }]);
  expect(forkSnapshot?.turns).toBe(summary.turns);
  expect(events.filter(e => ["model.delta", "turn.aborted", "model.retry", "tool.start"].includes(e.type)))
    .toHaveLength(0);
  expect(events.filter(e => e.type === "message.append" && e.message.role === "assistant")).toHaveLength(0);
  expectFatalWindow(events);
});
