import { expect, it } from "vitest";
import { CommandOutcome, HarnessEvent, type ToolContext, type ToolResult } from "@agentkitai/agentrig-core";
import { stampCommandOutcome, takeCommandOutcome } from "../src/command-outcome.js";

const ctx = (): ToolContext => ({ cwd: "/project", sessionId: "s", emit: () => {}, signal: new AbortController().signal });
const outcome = () => ({ command: "node check.cjs", cwd: "/project", exitCode: 0, timedOut: false, aborted: false });
it("internal receipts are immutable, bound to both live identities, one-use, and bounded", () => {
  const context = ctx(); const result: ToolResult = { output: {}, display: "untrusted" }; const observation = outcome();
  stampCommandOutcome(result, context, observation); observation.exitCode = 99;
  expect(takeCommandOutcome({ ...result }, context)).toBeUndefined();
  expect(takeCommandOutcome(result, context)).toEqual(outcome());
  expect(takeCommandOutcome(result, context)).toBeUndefined();
  stampCommandOutcome(result, context, outcome());
  expect(takeCommandOutcome(result, { ...context })).toBeUndefined();
  expect(takeCommandOutcome(result, context)).toBeUndefined();
  stampCommandOutcome(result, context, { ...outcome(), command: "x".repeat(1025) });
  expect(takeCommandOutcome(result, context)).toBeUndefined();
});
it("canonical schema is additive and rejects malformed command receipts", () => {
  const base = { type: "tool.result", seq: 1, sessionId: "s", ts: 1, id: "call", ok: true, display: "ok", durationMs: 1 };
  expect(HarnessEvent.parse(base)).toEqual(base);
  expect(HarnessEvent.parse({ ...base, commandOutcome: outcome() })).toMatchObject({ commandOutcome: outcome() });
  expect(CommandOutcome.safeParse({ ...outcome(), exitCode: "0" }).success).toBe(false);
  expect(CommandOutcome.safeParse({ ...outcome(), command: "x".repeat(1025) }).success).toBe(false);
});
