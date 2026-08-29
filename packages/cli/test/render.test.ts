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
