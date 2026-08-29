import { describe, expect, it } from "vitest";
import { HarnessEvent, parseEvent, serializeEvent } from "@agentkitai/agentrig-core";

describe("event schema", () => {
  it("round-trips a tool.call event through JSONL", () => {
    const event = HarnessEvent.parse({
      seq: 3,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "tool.call",
      id: "t1",
      name: "bash",
      input: { cmd: "ls" },
      inputHash: "deadbeef",
    });
    expect(parseEvent(serializeEvent(event))).toEqual(event);
  });

  it("round-trips a session.resume event", () => {
    const event = HarnessEvent.parse({
      seq: 40,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "session.resume",
      task: "keep going",
      cwd: "/w",
      provider: "anthropic",
      model: "m",
    });
    expect(parseEvent(serializeEvent(event))).toEqual(event);
  });

  it("round-trips a plan.updated carrying the M4 scope, and keeps scope optional", () => {
    const scoped = HarnessEvent.parse({
      seq: 41,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "plan.updated",
      items: [
        { id: "1", text: "wire the detectors", status: "in_progress", scope: ["packages/supervisor/src"] },
        { id: "2", text: "no declared scope", status: "pending" },
      ],
    });
    expect(parseEvent(serializeEvent(scoped))).toEqual(scoped);
    // scope is additive: a plan written before M4 still parses
    expect((scoped as { items: Array<{ scope?: string[] }> }).items[1]!.scope).toBeUndefined();
  });

  it("round-trips supervisor.signal and supervisor.intervention", () => {
    const sig = HarnessEvent.parse({
      seq: 42,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.signal",
      signal: { type: "loop", confidence: 0.9, evidence: ["same call 3x"], window: [1, 9] },
    });
    expect(parseEvent(serializeEvent(sig))).toEqual(sig);

    const iv = HarnessEvent.parse({
      seq: 43,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.intervention",
      intervention: { type: "abort", reason: "loop persisted" },
    });
    expect(parseEvent(serializeEvent(iv))).toEqual(iv);
  });

  it("rejects a signal whose confidence is out of range", () => {
    expect(() =>
      parseEvent(
        JSON.stringify({
          seq: 0,
          sessionId: "x",
          ts: 1,
          type: "supervisor.signal",
          signal: { type: "loop", confidence: 1.4, evidence: [], window: [0, 1] },
        }),
      ),
    ).toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => parseEvent(JSON.stringify({ seq: 0, sessionId: "x", ts: 1, type: "nope" }))).toThrow();
  });

  it("rejects a missing envelope", () => {
    expect(() => parseEvent(JSON.stringify({ type: "turn.start", n: 1 }))).toThrow();
  });
});
