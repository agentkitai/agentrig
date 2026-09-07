import type { EventPayload } from "./events.js";
import type { ContentBlock, InstructionContext } from "./messages.js";
import type { ModelRequest } from "./provider.js";
import { contentHash } from "./session-store.js";
import { isCompactionSummary } from "./compaction.js";

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
  context?: InstructionContext;
}

function payload(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_result") {
    return typeof block.content === "string" ? block.content : JSON.stringify(block.content);
  }
  return JSON.stringify(block);
}

function measured(
  source: ContextSource,
  origin: string,
  authority: ContextAuthority,
  reason: string,
  value: unknown,
  disposition: "kept" | "evicted" = "kept",
  freshness?: string,
  context?: InstructionContext,
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
    ...(context === undefined ? {} : { context }),
  };
}

export function renderSystemBlocks(blocks: readonly PromptBlock[]): string {
  return blocks.map((block) => block.content).filter((content) => content !== "").join("\n\n");
}

export function buildContextManifest(options: {
  turn: number;
  providerSelection?: ContextManifestEvent["providerSelection"];
  request: ModelRequest;
  systemBlocks: readonly PromptBlock[];
  evictedToolUseIds?: ReadonlySet<string>;
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
      block.context,
    ));

  const toolNames = new Map<string, string>();
  for (const message of options.request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  for (let messageIndex = 0; messageIndex < options.request.messages.length; messageIndex += 1) {
    const message = options.request.messages[messageIndex]!;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex]!;
      const evicted = block.type === "tool_result" && options.evictedToolUseIds?.has(block.toolUseId) === true;
      if (block.type === "tool_result") {
        const name = toolNames.get(block.toolUseId) ?? "tool";
        blocks.push(measured(
          "tool_result",
          `${name}:${block.toolUseId}`,
          block.context?.authority === "instruction" ? "instruction" : "data",
          evicted ? "stale large result replaced by outbound eviction policy" : "tool result retained in conversation",
          payload(block),
          evicted ? "evicted" : "kept",
          undefined,
          block.context,
        ));
      } else {
        blocks.push(measured(
          "history",
          `message:${messageIndex}:${message.role}:${blockIndex}`,
          block.context === undefined ? (message.role === "user" && !isCompactionSummary(block) ? "instruction" : "data")
            : block.context.authority === "instruction" ? "instruction" : "data",
          isCompactionSummary(block)
            ? "model-generated compaction summary retained for turn continuity"
            : "conversation history required for turn continuity",
          payload(block),
          "kept",
          undefined,
          block.context,
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
    ...(options.providerSelection === undefined ? {} : { providerSelection: options.providerSelection }),
    requestHash: contentHash(options.request),
    blocks,
  };
}
