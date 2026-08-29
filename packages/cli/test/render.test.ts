import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@agentkitai/agentrig-core";
import { renderEvent } from "../src/render.ts";

describe("renderEvent", () => {
  it("renders session.resume", () => {
    const e = HarnessEvent.parse({
      seq: 12,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "session.resume",
      task: "keep going",
      cwd: "/w",
      provider: "anthropic",
      model: "m",
    });
    const line = renderEvent(e);
    expect(line).toContain("session.resume");
    expect(line).toContain("anthropic/m");
    expect(line).toContain('"keep going"');
  });

  it("renders supervisor.signal with its type, confidence and evidence", () => {
    const e = HarnessEvent.parse({
      seq: 14,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.signal",
      signal: { type: "loop", confidence: 0.83, evidence: ["called bash 3x", "inputHash=deadbeef"], window: [4, 9] },
    });
    const line = renderEvent(e);
    expect(line).toContain("loop");
    expect(line).toContain("0.83");
    expect(line).toContain("called bash 3x");
    expect(line).toContain("inputHash=deadbeef");
  });

  it("renders supervisor.intervention for each kind the ladder can produce", () => {
    const kinds = [
      { type: "inject_guidance", message: "stop repeating yourself" },
      { type: "force_replan" },
      { type: "run_reviewer", reason: "loop: same call 3x" },
      { type: "run_grader", rubric: "the suite must pass" },
      { type: "escalate", question: "how should this proceed?" },
      { type: "abort", reason: "loop persisted" },
    ];
    for (const [i, intervention] of kinds.entries()) {
      const e = HarnessEvent.parse({
        seq: 20 + i,
        sessionId: "abc",
        ts: 1_700_000_000_000,
        type: "supervisor.intervention",
        intervention,
      });
      const line = renderEvent(e);
      expect(line).toContain("supervisor.intervention");
      expect(line).toContain(intervention.type);
    }
  });

  it("shows an intervention's payload rather than dumping raw JSON at the reader", () => {
    const e = HarnessEvent.parse({
      seq: 30,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "supervisor.intervention",
      intervention: { type: "run_reviewer", reason: "loop: called bash with identical input 3 times" },
    });
    const line = renderEvent(e);
    expect(line).toContain("called bash with identical input 3 times");
    expect(line).not.toContain('{"type"');
  });

  it("renders update_plan's plan.updated with each step's status", () => {
    const e = HarnessEvent.parse({
      seq: 31,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "plan.updated",
      items: [
        { id: "1", text: "wire the reviewer", status: "done", scope: ["packages/supervisor/src"] },
        { id: "2", text: "write the tests", status: "in_progress" },
      ],
    });
    const line = renderEvent(e);
    expect(line).toContain("done:wire the reviewer");
    expect(line).toContain("in_progress:write the tests");
  });

  it("renders context.compact", () => {
    const e = HarnessEvent.parse({
      seq: 13,
      sessionId: "abc",
      ts: 1_700_000_000_000,
      type: "context.compact",
      before: 90_000,
      after: 12_000,
    });
    expect(renderEvent(e)).toContain("90000 -> 12000");
  });
});
