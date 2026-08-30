import { z } from "zod";

/**
 * The slice of the Model Context Protocol a *client* needs: JSON-RPC 2.0 over a transport,
 * `initialize`, `tools/list`, `tools/call`.
 *
 * Written against the wire format rather than taken as a dependency. The official SDK would pull
 * a large surface for what is three request shapes, and this harness's whole point is that a
 * server's tools become ordinary `Tool`s — the adapter is the interesting part, not the plumbing.
 */

export const PROTOCOL_VERSION = "2024-11-05";

export const JsonRpcId = z.union([z.string(), z.number()]);

export const JsonRpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcId.nullable(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** A server may push notifications (no id); a client that assumed every line was a reply would
 *  mis-pair responses to requests. */
export const JsonRpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

export const InitializeResult = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
  capabilities: z.record(z.unknown()).optional(),
});

export const McpToolSpec = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
});
export type McpToolSpec = z.infer<typeof McpToolSpec>;

export const ToolsListResult = z.object({
  tools: z.array(McpToolSpec).default([]),
  nextCursor: z.string().optional(),
});

/** Content blocks a tool call can return. Only text is rendered; the rest is named, not dropped. */
export const McpContent = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), mimeType: z.string().optional() }).passthrough(),
    z.object({ type: z.string() }).passthrough(),
  ]),
);

export const ToolsCallResult = z.object({
  content: McpContent.default([]),
  isError: z.boolean().optional(),
});
export type ToolsCallResult = z.infer<typeof ToolsCallResult>;

/** Renders MCP content blocks into the single string the model sees. */
export function renderContent(content: z.infer<typeof McpContent>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string") parts.push(block.text);
    // a non-text block is named rather than silently dropped: the model should know something
    // came back that it cannot see
    else parts.push(`[${block.type} content omitted]`);
  }
  return parts.join("\n");
}
