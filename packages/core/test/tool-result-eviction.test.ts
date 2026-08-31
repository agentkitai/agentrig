import { describe, expect, it } from "vitest";
import { evictToolResults, type Message } from "@agentkitai/agentrig-core";

function conversation(payloads: string[]): Message[] {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "inspect files" }] }];
  payloads.forEach((payload, index) => {
    const id = `call-${index + 1}`;
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "read_file", input: { path: `src/file-${index + 1}.ts` } }],
    });
    messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: id, content: payload }] });
  });
  return messages;
}

function result(messages: Message[], id: string) {
  return messages.flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.toolUseId === id);
}

describe("tool-result eviction view", () => {
  it("never evicts tool results from the most recent K turns", () => {
    const original = conversation(["old".repeat(200), "middle".repeat(200), "new".repeat(200)]);
    const viewed = evictToolResults(original, { keepLastTurns: 2, minBytes: 100 });

    expect(result(viewed.messages, "call-1")).toMatchObject({
      toolUseId: "call-1",
      content: "read of src/file-1.ts elided — re-read if needed",
    });
    expect(result(viewed.messages, "call-2")).toEqual(result(original, "call-2"));
    expect(result(viewed.messages, "call-3")).toEqual(result(original, "call-3"));
    expect(viewed.count).toBe(1);
  });

  it("is a pure view that preserves tool pairing, small results, and the full source history", () => {
    const original = conversation(["large payload ".repeat(100), "small"]);
    const before = structuredClone(original);
    const viewed = evictToolResults(original, { keepLastTurns: 1, minBytes: 100 });

    expect(original).toEqual(before);
    expect(viewed.messages).not.toBe(original);
    expect(result(viewed.messages, "call-1")).toMatchObject({ type: "tool_result", toolUseId: "call-1" });
    expect(result(viewed.messages, "call-2")).toEqual(result(original, "call-2"));
    expect(viewed.bytesSaved).toBeGreaterThan(1_000);
  });

  it("does nothing when disabled", () => {
    const original = conversation(["large".repeat(500)]);
    expect(evictToolResults(original, { enabled: false, keepLastTurns: 0, minBytes: 0 })).toEqual({
      messages: original,
      count: 0,
      bytesSaved: 0,
    });
  });
});
