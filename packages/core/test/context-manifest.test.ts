import { describe, expect, it } from "vitest";
import {
  buildContextManifest,
  contentHash,
  type Message,
  type ModelRequest,
  type PromptBlock,
} from "@agentkitai/agentrig-core";

const systemBlocks: PromptBlock[] = [
  {
    content: "obey the operator",
    source: "system_prompt",
    origin: "test:system",
    authority: "instruction",
    reason: "base instructions",
  },
  {
    content: "repo map secret body",
    source: "repo_map",
    origin: "/repo",
    authority: "data",
    reason: "repository orientation",
    freshness: "mtime-marker-1",
  },
];

function request(messages: Message[]): ModelRequest {
  return {
    system: systemBlocks.map((block) => block.content).join("\n\n"),
    messages,
    tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
    maxTokens: 100,
  };
}

describe("context manifest", () => {
  it("records provenance, authority, freshness and final request hash without content", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "private task body" }] }];
    const req = request(messages);
    const manifest = buildContextManifest({ turn: 1, request: req, systemBlocks, originalMessages: messages });

    expect(manifest.requestHash).toBe(contentHash(req));
    expect(manifest.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "system_prompt", authority: "instruction", disposition: "kept" }),
      expect.objectContaining({ source: "repo_map", authority: "data", freshness: "mtime-marker-1" }),
      expect.objectContaining({ source: "history", authority: "instruction", origin: "message:0:user:0" }),
      expect.objectContaining({ source: "tool_catalogue", authority: "data" }),
    ]));
    const stored = JSON.stringify(manifest);
    expect(stored).not.toContain("private task body");
    expect(stored).not.toContain("repo map secret body");
  });

  it("marks an outbound tool-result stub as evicted and hashes what was actually sent", () => {
    const original: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "large.ts" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: "large private result" }] },
    ];
    const outbound: Message[] = [
      original[0]!,
      { role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: "read elided" }] },
    ];
    const manifest = buildContextManifest({
      turn: 6,
      request: request(outbound),
      systemBlocks,
      originalMessages: original,
    });

    expect(manifest.blocks).toContainEqual(expect.objectContaining({
      source: "tool_result",
      origin: "read_file:call-1",
      disposition: "evicted",
      hash: contentHash(JSON.stringify(outbound[1]!.content[0])),
    }));
  });
});
