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

  it("rejects an unknown event type", () => {
    expect(() => parseEvent(JSON.stringify({ seq: 0, sessionId: "x", ts: 1, type: "nope" }))).toThrow();
  });

  it("rejects a missing envelope", () => {
    expect(() => parseEvent(JSON.stringify({ type: "turn.start", n: 1 }))).toThrow();
  });
});
