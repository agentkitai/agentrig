/** Unified message schema. Providers map to/from this; core never sees a vendor payload. */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { type: "image"; mediaType: string; data: string };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}
