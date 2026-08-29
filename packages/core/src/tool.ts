import type { z } from "zod";
import type { EventPayload, PermissionClass } from "./events.js";

export interface ToolContext {
  cwd: string;
  sessionId: string;
  emit(payload: EventPayload): void;
  signal: AbortSignal;
}

export interface ToolResult<O = unknown> {
  output: O;
  /** What the model sees. Keep it bounded; set `truncated` if you cut it. */
  display: string;
  truncated?: boolean;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  permission: PermissionClass | ((input: I) => PermissionClass);
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
