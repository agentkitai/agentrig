import { describe, expect, it } from "vitest";
import {
  GuidanceLog,
  createAgent,
  SessionStore,
  contentHash,
  undeliveredSteerMessage,
  type EventPayload,
  type HarnessEvent,
} from "@agentkitai/agentrig-core";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * R17e's attribution rules, stated as tests because each of them is a way to be wrong in a way a
 * reader cannot see: claiming guidance was injected when it was only queued, attributing it to the
 * turn it was decided during rather than the one that carried it, or letting a user message wear
 * the supervisor's reasoning.
 */

let seq = 0;
const at = (payload: EventPayload, session = "s1"): HarnessEvent =>
  ({ ...payload, seq: seq++, sessionId: session, ts: 1_700_000_000_000 + seq } as HarnessEvent);

function feed(log: GuidanceLog, payloads: EventPayload[], session = "s1"): void {
  for (const payload of payloads) log.push(at(payload, session));
}

const GUIDANCE = "[supervisor: loop] stop repeating yourself";

const decided = (id: string, message = GUIDANCE): EventPayload[] => [
  {
    type: "supervisor.intervention",
    id,
    intervention: { type: "inject_guidance", message },
    noticed: [{ type: "loop", confidence: 0.9, evidence: ["same inputHash 3x"], window: [1, 9] }],
  },
  {
    type: "supervisor.outcome",
    id,
    intervention: "inject_guidance",
    outcome: "queued",
    detail: "queued for the next turn boundary; the steer event is the receipt",
    cost: { modelCalls: "none", injected: { bytes: Buffer.byteLength(message, "utf8"), hash: contentHash(message) } },
  },
];

describe("guidance fold", () => {
  it("does not claim a model request when a real pre_model hook vetoed it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrig-guidance-veto-"));
    let calls = 0;
    const session = createAgent({
      provider: { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 32000 },
        async *stream() { calls += 1; yield { type: "stop" as const, reason: "end_turn" as const }; } },
      store: new SessionStore({ root }), tools: [], permissions: { decide: async () => "deny" },
      systemPrompt: "test", repoMap: false,
      hooks: [{ point: "pre_model", handler: async () => ({ action: "deny", reason: "test veto" }) }],
    }).run("test", { cwd: root });
    session.control.steer(GUIDANCE, "supervisor");
    const log = new GuidanceLog();
    try {
      for await (const event of session.events) log.push(event);
      await session.done;
      expect(calls).toBe(0);
      expect(log.explainLast()).toMatchObject({ complete: true, requestRecorded: false });
      expect(log.explainLast()?.injected[0]?.message).toBe(GUIDANCE);
    } finally {
      session.control.abort();
      await session.done;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("evicts decision correlation too, rather than retaining unbounded side indexes", () => {
    const log = new GuidanceLog();
    for (let i = 0; i < 1000; i += 1) feed(log, decided(`i${i}`, `message-${i}`));
    feed(log, [
      { type: "steer", source: "supervisor", message: "message-0" },
      { type: "steer", source: "supervisor", message: "message-999" },
      { type: "turn.start", n: 1 },
      { type: "model.request", tokensIn: 1 },
    ]);
    const explanation = log.explainLast()!;
    expect(explanation.injected[0]?.decision).toBeUndefined();
    expect(explanation.injected[1]?.decision?.id).toBe("i999");
    expect(explanation.requestRecorded).toBe(true);
    expect(explanation.otherDecisions.length).toBeLessThanOrEqual(64);
  });

  it("attributes guidance to the turn that carried it, not the turn it was decided during", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      ...decided("i1"),
      { type: "turn.end", n: 1 },
      // core drains queued steers immediately before the next turn.start
      { type: "steer", source: "supervisor", message: GUIDANCE },
      { type: "turn.start", n: 2 },
      { type: "turn.end", n: 2 },
    ]);

    const explained = log.explainLast()!;
    expect(explained.turn).toBe(2);
    expect(explained.complete).toBe(true);
    expect(explained.injected).toHaveLength(1);
    expect(explained.injected[0]!.source).toBe("supervisor");
    expect(explained.injected[0]!.decision?.intervention.type).toBe("inject_guidance");
    expect(explained.injected[0]!.decision?.noticed[0]?.type).toBe("loop");
    expect(explained.injected[0]!.decision?.outcome?.outcome).toBe("queued");
    expect(explained.injected[0]!.decision?.outcome?.cost.modelCalls).toBe("none");
  });

  it("never reports a decision as injected when the session ended before it was delivered", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      ...decided("i1"),
      { type: "turn.end", n: 1 },
      { type: "error", message: undeliveredSteerMessage("supervisor", GUIDANCE), fatal: false },
      { type: "session.end", reason: "budget" },
    ]);

    const explained = log.explainLast()!;
    expect(explained.turn).toBe(1);
    expect(explained.injected).toHaveLength(0);
    expect(explained.undelivered).toEqual([{ seq: expect.any(Number), source: "supervisor", message: GUIDANCE }]);
    // the decision is still visible — as a decision that injected nothing
    expect(explained.otherDecisions.map((d) => d.intervention.type)).toEqual(["inject_guidance"]);
  });

  it("does not let a user message with identical text wear the supervisor's reasoning", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      ...decided("i1"),
      { type: "turn.end", n: 1 },
      { type: "steer", source: "user", message: GUIDANCE },
      { type: "turn.start", n: 2 },
    ]);

    const explained = log.explainLast()!;
    expect(explained.injected[0]!.source).toBe("user");
    expect(explained.injected[0]!.decision).toBeUndefined();
  });

  it("matches two queued decisions to their two steers in order", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      ...decided("i1", "first message"),
      ...decided("i2", "second message"),
      { type: "turn.end", n: 1 },
      { type: "steer", source: "supervisor", message: "first message" },
      { type: "steer", source: "supervisor", message: "second message" },
      { type: "turn.start", n: 2 },
    ]);

    const explained = log.explainLast()!;
    expect(explained.injected.map((e) => e.decision?.id)).toEqual(["i1", "i2"]);
    expect(explained.otherDecisions).toHaveLength(0);
  });

  it("separates the automatic memory block from memory tool results in the same request", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      {
        type: "context.manifest",
        turn: 1,
        requestHash: "abc123",
        blocks: [
          { source: "system_prompt", origin: "cli:default", authority: "instruction", hash: "h1", reason: "base", bytes: 10, tokens: 3, disposition: "kept" },
          { source: "memory_index", origin: "memory:wiki-index", authority: "data", hash: "h2", reason: "index", bytes: 40, tokens: 10, disposition: "kept" },
          { source: "tool_result", origin: "memory_search:tu1", authority: "data", hash: "h3", reason: "kept", bytes: 80, tokens: 20, disposition: "kept" },
          { source: "tool_result", origin: "bash:tu2", authority: "data", hash: "h4", reason: "kept", bytes: 5, tokens: 2, disposition: "kept" },
          { source: "history", origin: "message:0:user:0", authority: "instruction", hash: "h5", reason: "history", bytes: 6, tokens: 2, disposition: "kept" },
        ],
      },
    ]);

    const context = log.explainLast({ recallTools: new Set(["memory_search"]) })!.context!;
    expect(context.automatic.map((b) => b.source)).toEqual(["system_prompt", "memory_index"]);
    expect(context.recalls.map((b) => b.origin)).toEqual(["memory_search:tu1"]);
    expect(context.requestHash).toBe("abc123");
  });

  it("resets at every conversation boundary so a new run cannot show the previous one", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      { type: "steer", source: "user", message: "old run" },
      { type: "turn.start", n: 2 },
    ]);
    expect(log.explainLast()!.injected).toHaveLength(1);

    for (const boundary of [
      { type: "session.start", task: "t2", cwd: "/w", provider: "fake", model: "m" },
      { type: "session.resume", task: "t2", cwd: "/w", provider: "fake", model: "m" },
      { type: "session.fork", parent: "s1", atSeq: 2 },
    ] satisfies EventPayload[]) {
      const fresh = new GuidanceLog();
      feed(fresh, [
        { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
        { type: "turn.start", n: 1 },
        { type: "steer", source: "user", message: "old run" },
        { type: "turn.start", n: 2 },
        boundary,
      ], "s2");
      expect(fresh.explainLast()).toBeNull();
    }
  });

  it("reports nothing rather than the previous turn when no turn has started", () => {
    const log = new GuidanceLog();
    feed(log, [{ type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" }]);
    expect(log.explainLast()).toBeNull();
  });

  it("keeps guidance queued after the last turn started out of that turn's account", () => {
    const log = new GuidanceLog();
    feed(log, [
      { type: "session.start", task: "t", cwd: "/w", provider: "fake", model: "m" },
      { type: "turn.start", n: 1 },
      { type: "steer", source: "hook", message: "later" },
    ]);
    const explained = log.explainLast()!;
    expect(explained.injected).toHaveLength(0);
    expect(explained.pending.map((p) => p.message)).toEqual(["later"]);
  });
});
