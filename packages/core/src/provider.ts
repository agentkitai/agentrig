import type { Message } from "./messages.js";
import type { Usage } from "./events.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (derived from the tool's zod schema). */
  inputSchema: Record<string, unknown>;
}

/** Effort levels an entry may pin; each adapter maps them onto its own wire field. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  cacheHints?: {
    systemPrefix?: boolean;
    /** Character boundary for a stable cached prefix when mutable context follows it. */
    systemPrefixChars?: number;
  };
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error";

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "usage"; usage: Usage }
  /** `raw` carries the provider's verbatim stop reason when it doesn't map cleanly. */
  | { type: "stop"; reason: StopReason; raw?: string }
  /**
   * A transient failure was retried inside the provider (see `streamWithRetries`). Informational:
   * it carries no content, and the loop records it as a `model.retry` session event so the log
   * explains why a turn took 30 extra seconds — the two dead R1.5a sessions were diagnosed from
   * the outside precisely because nothing in the log said the provider was struggling.
   */
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; reason: string };

export interface ModelProvider {
  id: string;
  model: string;
  capabilities: {
    tools: boolean;
    parallelTools: boolean;
    caching: boolean;
    contextWindow: number;
    /** Fractions of normal input price; model-derived defaults used only when explicit rates are absent. */
    cacheReadDiscount?: number;
    cacheWriteMultiplier?: number;
  };
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens?(req: ModelRequest): Promise<number>;
}
