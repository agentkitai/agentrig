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

  it("round-trips a context.loaded event with its source path and byte count", () => {
    const event = HarnessEvent.parse({
      seq: 39,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.loaded",
      path: "/repo/AGENTS.md",
      bytes: 123,
    });
    expect(parseEvent(serializeEvent(event))).toEqual(event);
  });

  it("round-trips a context.repo_map accounting event without carrying map content", () => {
    const event = HarnessEvent.parse({
      seq: 40,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.repo_map",
      bytes: 4096,
      files: 87,
      truncated: true,
      freshness: "abc123",
    });
    expect(parseEvent(serializeEvent(event))).toEqual(event);
    expect(event).not.toHaveProperty("content");
  });

  it("round-trips a model.retry event, so slow turns are explicable from the log alone", () => {
    const event = HarnessEvent.parse({
      seq: 7,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "model.retry",
      attempt: 1,
      maxAttempts: 4,
      delayMs: 1000,
      reason: "openai-chatgpt stream error: Our servers are currently overloaded.",
    });
    expect(parseEvent(serializeEvent(event))).toEqual(event);
    // the bounds are part of the contract: attempt 0 is not a retry that happened
    expect(HarnessEvent.safeParse({ seq: 7, sessionId: "abc", ts: 0, type: "model.retry", attempt: 0, maxAttempts: 4, delayMs: 1000, reason: "x" }).success).toBe(false);
    expect(HarnessEvent.safeParse({ seq: 7, sessionId: "abc", ts: 0, type: "model.retry", attempt: 1, maxAttempts: 0, delayMs: 1000, reason: "x" }).success).toBe(false);
  });

  it("round-trips a context.evicted event with count and bytes saved", () => {
    const event = HarnessEvent.parse({
      seq: 40,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.evicted",
      count: 3,
      bytesSaved: 42_000,
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
      turns: 42,
    });
    expect(parseEvent(serializeEvent(event))).toEqual(event);
    // Additive field: old immutable logs without cumulative turns still parse.
    const legacy = { ...event } as Record<string, unknown>;
    delete legacy.turns;
    expect(HarnessEvent.parse(legacy)).not.toHaveProperty("turns");
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

  it("round-trips the M6 run_reviewer intervention", () => {
    const e = HarnessEvent.parse({
      seq: 44,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.intervention",
      intervention: { type: "run_reviewer", reason: "loop: same call 3x" },
    });
    expect(parseEvent(serializeEvent(e))).toEqual(e);
  });

  it("round-trips subagent.spawn/end, and keeps M7's reason optional", () => {
    const spawned = HarnessEvent.parse({
      seq: 3, sessionId: "p", ts: 1, type: "subagent.spawn", id: "c1", task: "counting files",
    });
    expect(spawned).toMatchObject({ type: "subagent.spawn", id: "c1" });

    const ended = HarnessEvent.parse({ seq: 4, sessionId: "p", ts: 1, type: "subagent.end", id: "c1", reason: "budget" });
    expect(ended).toMatchObject({ type: "subagent.end", reason: "budget" });

    // logs written before M7 added `reason` must still parse — fields are added, never repurposed
    expect(HarnessEvent.safeParse({ seq: 5, sessionId: "p", ts: 1, type: "subagent.end", id: "c1" }).success).toBe(true);
    // ...and a reason that is not a SessionSummary reason is not one of ours
    expect(
      HarnessEvent.safeParse({ seq: 6, sessionId: "p", ts: 1, type: "subagent.end", id: "c1", reason: "cancelled" }).success,
    ).toBe(false);
  });

  it("round-trips a permission.request carrying M7's origin, and keeps it optional", () => {
    const withOrigin = HarnessEvent.parse({
      seq: 7, sessionId: "p", ts: 1, type: "permission.request",
      req: { tool: "write_file", input: {}, class: "write", cwd: "/w", origin: "subagent" },
    });
    expect(withOrigin).toMatchObject({ req: { origin: "subagent" } });
    expect(
      HarnessEvent.safeParse({
        seq: 8, sessionId: "p", ts: 1, type: "permission.request",
        req: { tool: "write_file", input: {}, class: "write", cwd: "/w" },
      }).success,
    ).toBe(true);
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
