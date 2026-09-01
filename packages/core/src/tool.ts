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
  /** What the model sees. Core applies its final display bound before sending it. */
  display: string;
  truncated?: boolean;
  /**
   * Complete text from which `display` was truncated by a tool-specific bound. Core persists this
   * only for overflow artifacts; omit it when `truncated` means the tool stopped collecting data.
   */
  fullDisplay?: string;
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
  /**
   * The JSON Schema shown to the MODEL, when it cannot be derived from `inputSchema`.
   *
   * An MCP server describes its tools in JSON Schema already; converting that to zod and back
   * would degrade it to "an object", losing every field description the server wrote — which is
   * exactly what the model needs to call the tool correctly. `inputSchema` still governs
   * validation, so a permissive zod schema plus the server's real schema is honest on both
   * sides rather than a lossy round trip.
   */
  jsonSchema?: Record<string, unknown>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/**
 * A Tool with its input type erased — what registries and the loop hold.
 * `any` on purpose: Tool<I> is contravariant in I, so Tool<Concrete> is not assignable
 * to Tool<unknown>; the loop re-validates input through inputSchema before executing.
 */
export type AnyTool = Tool<any, any>;
