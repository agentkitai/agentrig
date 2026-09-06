import { ThinkingBlockSchema, type ThinkingBlock, type Message, type ContentBlock } from "../messages.js";

type JsonObject = Record<string, unknown>;
const fail = (): never => { throw new Error("unsupported, invalid or oversized reasoning replay"); };

/** Validate before parsing; opaque data is never included in an error. */
function parseReplay(text: string): JsonObject {
  if (Buffer.byteLength(text) > 262_144) fail();
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { if (++depth > 16) fail(); }
    else if (char === "}" || char === "]") depth--;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    return value as JsonObject;
  } catch { return fail(); }
}

export function thinkingFromItem(format: ThinkingBlock["format"], item: JsonObject): ThinkingBlock {
  const replay = JSON.stringify(item);
  parseReplay(replay);
  let text = "", signature: string | undefined, id: string | undefined;
  if (format === "anthropic") {
    if (item.type === "thinking" && typeof item.thinking === "string" && typeof item.signature === "string" && item.signature !== "") {
      text = item.thinking; signature = item.signature;
    } else if (item.type === "redacted_thinking" && typeof item.data === "string" && item.data !== "") signature = item.data;
    else return fail();
  } else {
    if (item.type !== "reasoning" || typeof item.id !== "string" || item.id === "") return fail();
    id = item.id;
    if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
      if (typeof item.encrypted_content !== "string") return fail();
      signature = item.encrypted_content;
    }
    if (item.summary !== undefined) {
      if (!Array.isArray(item.summary) || item.summary.length > 128) return fail();
      text = item.summary.map((part: unknown) => {
        if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") return fail();
        return part.text;
      }).join("\n");
    }
  }
  const parsed = ThinkingBlockSchema.safeParse({ type: "thinking", format, text, replay,
    ...(signature === undefined ? {} : { signature }), ...(id === undefined ? {} : { id }) });
  if (!parsed.success) return fail();
  return parsed.data;
}

export function thinkingToItem(block: ThinkingBlock, format: ThinkingBlock["format"]): JsonObject {
  const parsed = ThinkingBlockSchema.safeParse(block);
  if (!parsed.success || block.format !== format) return fail();
  const item = parseReplay(block.replay);
  const expected = thinkingFromItem(format, item);
  if (expected.text !== block.text || expected.signature !== block.signature || expected.id !== block.id) return fail();
  return item;
}

/** Only top-level assistant reasoning is legal; never forward it as tool/user content. */
export function validateThinkingHistory(messages: readonly Message[], format?: ThinkingBlock["format"]): void {
  const visit = (blocks: readonly ContentBlock[], assistant: boolean): void => {
    for (const block of blocks) {
      if (block.type === "thinking") {
        if (!assistant || format === undefined) fail();
        thinkingToItem(block, format!);
      } else if (block.type === "tool_result" && Array.isArray(block.content)) visit(block.content, false);
    }
  };
  for (const message of messages) visit(message.content, message.role === "assistant");
}
