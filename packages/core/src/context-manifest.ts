import type { EventPayload } from "./events.js";
import type { ContentBlock, Message } from "./messages.js";
import type { ModelRequest } from "./provider.js";
import { contentHash } from "./session-store.js";

export type ContextManifestEvent = Extract<EventPayload, { type: "context.manifest" }>;
export type ContextManifestBlock = ContextManifestEvent["blocks"][number];
export type ContextSource = ContextManifestBlock["source"];
export type ContextAuthority = ContextManifestBlock["authority"];

/** A labelled component of the system string. Core joins these with the same blank-line boundary. */
export interface PromptBlock {
  content: string;
  source: Extract<ContextSource, "system_prompt" | "project_instructions" | "repo_map" | "memory_index" | "skills_catalogue" | "git_state">;
  origin: string;
  authority: ContextAuthority;
  reason: string;
  freshness?: string;
}

function serialized(block: ContentBlock): string {
  return block.type === "text" ? block.text : JSON.stringify(block);
}

function measured(
  source: ContextSource,
  origin: string,
  authority: ContextAuthority,
  reason: string,
  value: unknown,
  disposition: "kept" | "evicted" = "kept",
  freshness?: string,
): ContextManifestBlock {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    source,
    origin,
    authority,
    hash: contentHash(text),
    reason,
    bytes,
    tokens: Math.ceil(bytes / 4),
    disposition,
    ...(freshness === undefined ? {} : { freshness }),
  };
}

export function renderSystemBlocks(blocks: readonly PromptBlock[]): string {
  return blocks.map((block) => block.content).filter((content) => content !== "").join("\n\n");
}

export function buildContextManifest(options: {
  turn: number;
  request: ModelRequest;
  systemBlocks: readonly PromptBlock[];
  originalMessages: readonly Message[];
}): ContextManifestEvent {
  const blocks: ContextManifestBlock[] = options.systemBlocks
    .filter((block) => block.content !== "")
    .map((block) => measured(
      block.source,
      block.origin,
      block.authority,
      block.reason,
      block.content,
      "kept",
      block.freshness,
    ));

  const toolNames = new Map<string, string>();
  for (const message of options.request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  for (let messageIndex = 0; messageIndex < options.request.messages.length; messageIndex += 1) {
    const message = options.request.messages[messageIndex]!;
    const original = options.originalMessages[messageIndex];
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex]!;
      const before = original?.content[blockIndex];
      const evicted = block.type === "tool_result" && before?.type === "tool_result" && serialized(block) !== serialized(before);
      if (block.type === "tool_result") {
        const name = toolNames.get(block.toolUseId) ?? "tool";
        blocks.push(measured(
          "tool_result",
          `${name}:${block.toolUseId}`,
          "data",
          evicted ? "stale large result replaced by outbound eviction policy" : "tool result retained in conversation",
          serialized(block),
          evicted ? "evicted" : "kept",
        ));
      } else {
        blocks.push(measured(
          "history",
          `message:${messageIndex}:${message.role}:${blockIndex}`,
          message.role === "user" ? "instruction" : "data",
          "conversation history required for turn continuity",
          serialized(block),
        ));
      }
    }
  }

  if (options.request.tools.length > 0) {
    blocks.push(measured(
      "tool_catalogue",
      `tools:${options.request.tools.length}`,
      "data",
      "tool schemas advertised for this request",
      options.request.tools,
    ));
  }

  return {
    type: "context.manifest",
    turn: options.turn,
    requestHash: contentHash(options.request),
    blocks,
  };
}
