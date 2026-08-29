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
  /**
   * Expected failure (non-zero exit, file not found, bad pattern): the display still reaches
   * the model, flagged as an error. Throwing is reserved for unexpected failures.
   */
  isError?: boolean;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  permission: PermissionClass | ((input: I) => PermissionClass);
  /**
   * The filesystem paths a call would touch (raw, as given — relative paths are resolved
   * against the session cwd by the policy). Lets policies confine a tool to the working
   * directory (`cwdOnly` rules). A tool without this cannot be path-confined (e.g. bash).
   */
  paths?(input: I): string[];
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/**
 * A Tool with its input type erased — what registries and the loop hold.
 * `any` on purpose: Tool<I> is contravariant in I, so Tool<Concrete> is not assignable
 * to Tool<unknown>; the loop re-validates input through inputSchema before executing.
 */
export type AnyTool = Tool<any, any>;
