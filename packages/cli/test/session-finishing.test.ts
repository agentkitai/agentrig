import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgent, HarnessEvent as Event, RulePolicy, SessionStore, TOOL_EMITTABLE_EVENTS, type HarnessEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
import { statusLine } from "../src/tui/status.js";
import { renderChatEvent, renderEvent } from "../src/render.js";

it("keeps a completed answer visibly finishing while owned maintenance remains unsettled", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-finishing-"));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const held = new Promise<void>(r => { release = r; });
  const events: HarnessEvent[] = [];
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { yield { type: "text_delta", text: "Answer is here." }; yield { type: "stop", reason: "end_turn" }; } };
  const agent = createAgent({ provider, tools: [], permissions: new RulePolicy([]), systemPrompt: "test",
    store: new SessionStore({ root }), hooks: [{ point: "session_end", handler: async () => { enter(); await held; return { action: "continue" }; } }] });
  const controller = new TuiController({ cwd: root, agent, onSession: session => {
    void (async () => { for await (const event of session.events) events.push(event); })();
  } });
  let settled = false;
  const work = controller.submit("Explain this").finally(() => { settled = true; });
  try {
    await entered;
    await vi.waitFor(() => expect(controller.snapshot().activity?.kind).toBe("maintenance"));
    expect(settled).toBe(false);
    expect(controller.snapshot().status).toBe("running"); // no unsafe early admission
    expect(statusLine(controller.snapshot())).toContain("finishing · session maintenance");
    expect(statusLine(controller.snapshot())).not.toContain(" · running · ");
    expect(events.some(e => e.type === "session.end")).toBe(false);
    const finishing = events.find(e => (e.type as string) === "session.finishing")!;
    expect(Event.parse(JSON.parse(JSON.stringify(finishing)))).toEqual(finishing);
    expect(renderEvent(finishing)).toContain("reason=done");
    expect(renderChatEvent(finishing)).toContain("Answer complete; finishing session maintenance");
  } finally {
    release(); await work; await controller.shutdown(); await rm(root, { recursive: true, force: true });
  }
  expect(controller.snapshot().status).toBe("idle");
  expect(controller.snapshot().activity).toBeNull();
  expect(events.at(-1)?.type).toBe("session.end");
  expect(events.filter(e => (e.type as string) === "session.finishing")).toHaveLength(1);
});

it("does not label budget/error/abort stops as a completed answer", () => {
  expect(TOOL_EMITTABLE_EVENTS.has("session.finishing")).toBe(false);
  expect(Event.safeParse({ type: "session.finishing", reason: "unknown", seq: 3, sessionId: "fixture", ts: 1 }).success).toBe(false);
  for (const reason of ["budget", "error", "aborted"]) {
    const event = Event.parse({ type: "session.finishing", reason, seq: 3, sessionId: "fixture", ts: 1 });
    expect(renderChatEvent(event)).toContain(`Task ${reason}; finishing session maintenance`);
    expect(renderChatEvent(event)).not.toContain("Answer complete");
  }
});
