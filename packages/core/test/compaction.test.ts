import { describe, expect, it } from "vitest";
import {
  summarizeOlderTurns,
  type Message,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

/** Returns a fixed summary text for every stream call and records the requests. */
function summaryProvider(summary = "SUMMARY"): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: "fake",
    model: "fake-1",
    capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 1000 },
    requests,
    async *stream(req): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(req));
      yield { type: "text_delta", text: summary };
      yield { type: "usage", usage: { input: 1, output: 1 } };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const turn = (n: number): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "bash", input: { command: `cmd ${n}` } }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: `t${n}`, content: `out ${n}` }] },
];

describe("summarizeOlderTurns", () => {
  it("compacts past the threshold fraction of the window", () => {
    const s = summarizeOlderTurns();
    expect(s.shouldCompact({ tokens: 699, window: 1000 })).toBe(false);
    expect(s.shouldCompact({ tokens: 701, window: 1000 })).toBe(true);
  });

  it("keeps the task and the last N messages verbatim, summarizing the middle", async () => {
    const messages: Message[] = [user("the task"), ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    const provider = summaryProvider();
    const s = summarizeOlderTurns({ keepLastMessages: 4 });
    const compacted = await s.compact(messages, provider);

    expect(compacted[0]).toEqual(user("the task"));
    expect(compacted[1]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("SUMMARY") });
    // last four messages = turns 4 and 5, untouched
    expect(compacted.slice(2)).toEqual([...turn(4), ...turn(5)]);
    // the summarization call saw the summarized middle, not the task or the tail
    const transcript = (provider.requests[0]!.messages[0]!.content[0] as { text: string }).text;
    expect(transcript).toContain("cmd 1");
    expect(transcript).toContain("out 3");
    expect(transcript).not.toContain("the task");
    expect(transcript).not.toContain("cmd 5");
  });

  it("widens the boundary so a kept tool_result never loses its tool_use", async () => {
    const messages: Message[] = [user("task"), ...turn(1), ...turn(2), ...turn(3)];
    // keepLast 3 would cut inside turn 2's pair: [assistant t3, user r3, user r?]... boundary
    // lands on turn 3's tool_result — the strategy must pull the assistant t3 into the tail.
    const s = summarizeOlderTurns({ keepLastMessages: 1 });
    const compacted = await s.compact(messages, summaryProvider());
    const tail = compacted.slice(2);
    expect(tail[0]).toMatchObject({ role: "assistant" });
    expect(tail).toEqual(turn(3));
  });

  it("returns short conversations unchanged without calling the provider", async () => {
    const provider = summaryProvider();
    const messages: Message[] = [user("task"), ...turn(1)];
    const s = summarizeOlderTurns({ keepLastMessages: 8 });
    expect(await s.compact(messages, provider)).toBe(messages);
    expect(provider.requests).toHaveLength(0);
  });
});
