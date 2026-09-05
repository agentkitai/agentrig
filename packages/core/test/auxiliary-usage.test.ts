import { expect, it } from "vitest";
import { HarnessEvent, SupervisorRecord, parseEvent, serializeEvent, parseAnthropicSse, parseOpenAISse, parseResponsesSse, type ModelEvent } from "@agentkitai/agentrig-core";

async function* stream(events: unknown[]) { for (const event of events) yield `data: ${JSON.stringify(event)}\n\n`; }
async function usage(events: AsyncIterable<ModelEvent>) { for await (const event of events) if (event.type === "usage") return event; throw new Error("missing usage event"); }

it("validates and round-trips cumulative auxiliary snapshots separately from model responses", () => {
  const record = { type: "auxiliary.usage", id: "review-1", final: false, report: {
    operation: "reviewer", outcome: "completed", durationMs: 1,
    calls: [{ operation: "completion", provider: "fixture", durationMs: 1, outcome: "completed", usageComplete: false }],
    reportedUsage: { input: 0, output: 0 }, unknownUsageCalls: 1, costUsd: null,
  } };
  expect(SupervisorRecord.safeParse(record).success).toBe(true);
  const event = HarnessEvent.parse({ ...record, seq: 1, ts: 1, sessionId: "s" });
  expect(parseEvent(serializeEvent(event))).toEqual(event);
  expect(SupervisorRecord.safeParse({ ...record, report: { ...record.report, durationMs: NaN } }).success).toBe(false);
  expect(SupervisorRecord.safeParse({ ...record, report: { ...record.report, costUsd: -1 } }).success).toBe(false);
  expect(SupervisorRecord.safeParse({ ...record, report: { ...record.report, reportedUsage: { input: -1, output: 0 } } }).success).toBe(false);
});

it("distinguishes missing OpenAI usage from a reported zero", async () => {
  expect(await usage(parseOpenAISse(stream([])))).toMatchObject({ reported: false, usage: { input: 0, output: 0 } });
  expect((await usage(parseOpenAISse(stream([{ usage: { prompt_tokens: 0, completion_tokens: 0 } }])))).reported).not.toBe(false);
});
it("distinguishes missing Responses usage from a reported zero", async () => {
  expect(await usage(parseResponsesSse(stream([])))).toMatchObject({ reported: false });
  expect((await usage(parseResponsesSse(stream([{ type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } }])))).reported).not.toBe(false);
});
it("marks partial Anthropic counts as incomplete without discarding the known portion", async () => {
  expect(await usage(parseAnthropicSse(stream([{ type: "message_start", message: { usage: { input_tokens: 7 } } }])))).toMatchObject({ reported: false, usage: { input: 7, output: 0 } });
  expect((await usage(parseAnthropicSse(stream([
    { type: "message_start", message: { usage: { input_tokens: 0 } } },
    { type: "message_delta", usage: { output_tokens: 0 }, delta: { stop_reason: "end_turn" } },
  ])))).reported).not.toBe(false);
});
