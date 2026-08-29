import type { Message } from "./messages.js";
import type { Usage } from "./events.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (derived from the tool's zod schema). */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  cacheHints?: { systemPrefix?: boolean };
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: "end_turn" | "tool_use" | "max_tokens" | "error" };

export interface ModelProvider {
  id: string;
  model: string;
  capabilities: { tools: boolean; parallelTools: boolean; caching: boolean; contextWindow: number };
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens?(req: ModelRequest): Promise<number>;
}
