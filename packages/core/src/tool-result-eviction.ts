import type { ContentBlock, Message } from "./messages.js";
import { outputHandleFromDisplay } from "./tools/read-output.js";

/** Outbound-only context policy. Stored conversation messages are never passed here for mutation. */
export interface ToolResultEvictionOptions {
  /** Defaults to true. */
  enabled?: boolean;
  /** Protected recent turns: explicit use selects legacy policy (default 5); window policy always protects at least 1. */
  keepLastTurns?: number;
  /** Evict only tool-result payloads larger than this many serialized JSON UTF-8 bytes (default 8 KiB). */
  minBytes?: number;
  /** Start/stop eviction at this fraction of the context window. Default: 0.5.
   * Explicitly setting this selects window policy even with legacy age/size overrides. */
  thresholdFraction?: number;
}

export interface ToolResultEvictionPressure {
  contextWindow: number;
  /** Estimate complete outbound input in characters / 4, including system text and tool schemas.
   * Called once per pass; savings use serialized UTF-16 characters, not UTF-8 bytes. */
  estimateTokens(messages: readonly Message[]): number;
}

export interface ToolResultEviction {
  messages: Message[];
  count: number;
  bytesSaved: number;
  /** Conservative post-eviction estimate, available when pressure was supplied. */
  estimatedTokens?: number;
  /** Stable identities of result blocks replaced in this outbound view. */
  evictedToolUseIds: ReadonlySet<string>;
}

export const DEFAULT_TOOL_RESULT_EVICTION = Object.freeze({
  enabled: true,
  keepLastTurns: 5,
  minBytes: 8 * 1024,
});

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

function payloadBytes(content: Extract<ContentBlock, { type: "tool_result" }>["content"]): number {
  // This is the payload's actual contribution to the JSON request, including escaping.
  return Buffer.byteLength(JSON.stringify(content), "utf8");
}

function shortTarget(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
}

function targetOf(input: unknown): string {
  if (input !== null && typeof input === "object") {
    const values = input as Record<string, unknown>;
    for (const key of ["path", "command", "pattern", "query", "task", "name"]) {
      const value = values[key];
      if (typeof value === "string" && value !== "") return shortTarget(value);
    }
  }
  const serialized = JSON.stringify(input);
  return serialized === undefined ? "its prior target" : shortTarget(serialized);
}

function outputHandle(content: Extract<ContentBlock, { type: "tool_result" }>["content"]): string | undefined {
  const text = typeof content === "string"
    ? content
    : content.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text).join("\n");
  return outputHandleFromDisplay(text);
}

function stubFor(
  toolUse: ToolUse,
  content: Extract<ContentBlock, { type: "tool_result" }>["content"],
): string {
  const target = targetOf(toolUse.input);
  const base = toolUse.name === "read_file"
    ? `read of ${target} elided — re-read if needed`
    // Unknown tools may have side effects, so never suggest replaying them automatically.
    : `${toolUse.name} of ${target} elided`;
  const handle = outputHandle(content);
  return handle === undefined ? base : `${base} — preserved overflow handle: ${handle}`;
}

/**
 * Build an eviction view of a conversation for one outbound model request.
 *
 * A result belongs to the assistant turn containing its paired tool_use. The newest K assistant
 * turns are load-bearing and remain byte-for-byte intact. Older large payloads become text stubs;
 * the result block and toolUseId remain, preserving provider tool-use/result pairing.
 * With pressure, evict oldest eligible results only until the view is below the threshold.
 * Without pressure (or with explicit legacy options), preserve the original age-based API.
 */
export function evictToolResults(
  messages: readonly Message[],
  options: ToolResultEvictionOptions = {},
  pressure?: ToolResultEvictionPressure,
): ToolResultEviction {
  const enabled = options.enabled ?? DEFAULT_TOOL_RESULT_EVICTION.enabled;
  const windowMode = pressure !== undefined && (options.thresholdFraction !== undefined ||
    (options.keepLastTurns === undefined && options.minBytes === undefined));
  const fraction = options.thresholdFraction ?? 0.5;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error("thresholdFraction must be > 0 and <= 1");
  }
  if (windowMode && (!Number.isFinite(pressure.contextWindow) || pressure.contextWindow <= 0)) {
    throw new Error("contextWindow must be positive and finite");
  }
  const threshold = windowMode ? pressure.contextWindow * fraction : Infinity;
  const requestedKeep = options.keepLastTurns ?? (windowMode ? 1 : DEFAULT_TOOL_RESULT_EVICTION.keepLastTurns);
  const keepLastTurns = windowMode ? Math.max(1, requestedKeep) : requestedKeep;
  const minBytes = options.minBytes ?? DEFAULT_TOOL_RESULT_EVICTION.minBytes;
  if (!Number.isInteger(requestedKeep) || requestedKeep < 0) throw new Error("keepLastTurns must be a non-negative integer");
  if (!Number.isInteger(minBytes) || minBytes < 0) throw new Error("minBytes must be a non-negative integer");
  const initialTokens = pressure?.estimateTokens(messages);
  let charactersSaved = 0;
  const estimate = () => initialTokens === undefined ? {} : { estimatedTokens: Math.max(0, initialTokens - Math.floor(charactersSaved / 4)) };
  const underThreshold = () => windowMode && estimate().estimatedTokens! < threshold;
  if (!enabled || underThreshold()) return { messages: messages as Message[], count: 0, bytesSaved: 0, evictedToolUseIds: new Set(), ...estimate() };

  const assistantTurns = messages.reduce(
    (count, message) => count + (message.role === "assistant" ? 1 : 0),
    0,
  );
  let assistantTurn = 0;
  const toolUses = new Map<string, { block: ToolUse; turn: number }>();
  let count = 0;
  let bytesSaved = 0;
  const evictedToolUseIds = new Set<string>();
  let outbound: Message[] | undefined;
  scan: for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role === "assistant") {
      assistantTurn += 1;
      for (const block of message.content) {
        if (block.type === "tool_use") toolUses.set(block.id, { block, turn: assistantTurn });
      }
    }
    let content: ContentBlock[] | undefined;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex]!;
      if (block.type !== "tool_result") continue;
      if (underThreshold()) break scan;
      // Flattening tagged child blocks into a string would silently discard provenance.
      // Keep this payload intact until R13b defines an explicit aggregation policy.
      const hasLabel = (child: ContentBlock): boolean => child.trust !== undefined || child.context !== undefined ||
        (child.type === "tool_result" && Array.isArray(child.content) && child.content.some(hasLabel));
      if (Array.isArray(block.content) && block.content.some(hasLabel)) continue;
      const toolUse = toolUses.get(block.toolUseId);
      if (toolUse === undefined || assistantTurns - toolUse.turn < keepLastTurns) continue;
      const before = payloadBytes(block.content);
      if (before <= minBytes) continue;
      const stub = stubFor(toolUse.block, block.content);
      const saved = before - Buffer.byteLength(JSON.stringify(stub), "utf8");
      if (saved <= 0) continue;

      outbound ??= messages.slice() as Message[];
      content ??= message.content.slice();
      content[blockIndex] = { ...block, content: stub };
      outbound[messageIndex] = { ...message, content };
      count += 1;
      bytesSaved += saved;
      // Rounding total savings down keeps the estimate conservative by at most one token.
      charactersSaved += JSON.stringify(block.content).length - JSON.stringify(stub).length;
      evictedToolUseIds.add(block.toolUseId);
    }
  }

  return { messages: outbound ?? (messages as Message[]), count, bytesSaved, evictedToolUseIds, ...estimate() };
}
