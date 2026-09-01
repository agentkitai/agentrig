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

  it("pairs repeated provider-local tool IDs with their positional assistant turn", () => {
    const original: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call-0", name: "read_file", input: { path: "old.ts" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call-0", content: "old".repeat(500) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call-0", name: "read_file", input: { path: "new.ts" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call-0", content: "new".repeat(500) }] },
    ];

    const viewed = evictToolResults(original, { keepLastTurns: 1, minBytes: 100 });

    expect(viewed.messages[1]!.content[0]).toMatchObject({ content: "read of old.ts elided — re-read if needed" });
    expect(viewed.messages[3]!.content[0]).toEqual(original[3]!.content[0]);
    expect(viewed.count).toBe(1);
  });

  it("preserves an overflow handle when the containing result is later evicted", () => {
    const handle = 'read_output {"seq":42,"from":29800,"to":31000}';
    const original = conversation([`${"large".repeat(500)}\n… [output truncated; ${handle}]`]);
    const viewed = evictToolResults(original, { keepLastTurns: 0, minBytes: 100 });
    const stub = result(viewed.messages, "call-1");
    if (stub?.type !== "tool_result" || typeof stub.content !== "string") throw new Error("missing stub");
    expect(stub.content).toContain(handle);
  });

  it("does not encourage replaying a potentially mutating tool", () => {
    const original: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "deploy", name: "bash", input: { command: "deploy production" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "deploy", content: "deployed".repeat(500) }] },
    ];

    const viewed = evictToolResults(original, { keepLastTurns: 0, minBytes: 100 });
    const stub = viewed.messages[1]!.content[0];

    expect(stub).toMatchObject({ type: "tool_result", toolUseId: "deploy" });
    if (stub?.type !== "tool_result" || typeof stub.content !== "string") throw new Error("missing stub");
    expect(stub.content).toContain("bash of deploy production elided");
    expect(stub.content).not.toContain("re-run");
  });

  it("does nothing when disabled", () => {
    const original = conversation(["large".repeat(500)]);
    expect(evictToolResults(original, { enabled: false, keepLastTurns: 0, minBytes: 0 })).toEqual({
      messages: original,
      count: 0,
      bytesSaved: 0,
      evictedToolUseIds: new Set(),
    });
  });
});
