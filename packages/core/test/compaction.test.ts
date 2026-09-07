import { describe, expect, it } from "vitest";
import {
  summarizeOlderTurns,
  compactWithProvenance,
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
  it("zero retention summarizes all later messages and conservatively preserves nested ancestry", async () => {
    const task = user("task");
    const messages: Message[] = [task, ...turn(1), { role: "user", content: [{ type: "tool_result", toolUseId: "nested", trust: "user", content: [{ type: "text", text: "external", trust: "external" }] }] }];
    const before = structuredClone(messages), provider = summaryProvider();
    const strategy = summarizeOlderTurns({ keepLastMessages: 0 });
    const once = await compactWithProvenance(strategy, messages, provider, new AbortController().signal);
    expect(once).toHaveLength(2); expect(once[0]).toEqual(task);
    expect(once[1]!.content[0]).toMatchObject({ type: "text", trust: "external", context: { principal: "platform", authority: "advisory" } });
    expect(provider.requests[0]!.messages[0]!.content[0]).toMatchObject({ trust: "external", text: expect.stringContaining("out 1") });
    const twice = await compactWithProvenance(strategy, [...once, user("new")], provider, new AbortController().signal);
    expect(twice[1]!.content[0]!.trust).toBe("external"); expect(messages).toEqual(before);
  });

  it("zero retention leaves empty and task-only histories unchanged without summary calls", async () => {
    const provider = summaryProvider(), strategy = summarizeOlderTurns({ keepLastMessages: 0 });
    for (const messages of [[], [user("task")]]) expect(await strategy.compact(messages, provider)).toBe(messages);
    expect(provider.requests).toHaveLength(0);
  });

  it("zero retention keeps real history when the summary is empty", async () => {
    const messages = [user("task"), ...turn(1)];
    expect(await summarizeOlderTurns({ keepLastMessages: 0 }).compact(messages, summaryProvider(" "))).toBe(messages);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid retained-message count %s at construction", keepLastMessages => {
    expect(() => summarizeOlderTurns({ keepLastMessages })).toThrow("keepLastMessages must be a nonnegative safe integer");
  });

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

  it("returns the input unchanged when the summary comes back empty", async () => {
    const messages: Message[] = [user("task"), ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    const s = summarizeOlderTurns({ keepLastMessages: 2 });
    expect(await s.compact(messages, summaryProvider(""))).toBe(messages);
  });

  it("passes the session signal through to the summarization call", async () => {
    let seen: AbortSignal | null = null;
    const provider = summaryProvider();
    const wrapped: ModelProvider = {
      ...provider,
      stream(req, signal) {
        seen = signal;
        return provider.stream(req, signal);
      },
    };
    const messages: Message[] = [user("task"), ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    const ac = new AbortController();
    await summarizeOlderTurns({ keepLastMessages: 2 }).compact(messages, wrapped, ac.signal);
    expect(seen).toBe(ac.signal);
  });

  it("returns short conversations unchanged without calling the provider", async () => {
    const provider = summaryProvider();
    const messages: Message[] = [user("task"), ...turn(1)];
    const s = summarizeOlderTurns({ keepLastMessages: 8 });
    expect(await s.compact(messages, provider)).toBe(messages);
    expect(provider.requests).toHaveLength(0);
  });
});
