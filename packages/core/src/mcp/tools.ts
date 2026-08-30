import { z } from "zod";
import type { AnyTool, Tool, ToolContext, ToolResult } from "../tool.js";
import type { McpClient } from "./client.js";
import { renderContent, type McpToolSpec } from "./protocol.js";

/**
 * Turns an MCP server's tools into ordinary `Tool`s, which is the whole point: once adapted they
 * go through the same permission policy, the same hooks, and the same event log as a builtin.
 * Nothing downstream needs to know MCP exists.
 *
 * Two decisions here are load-bearing and neither is obvious.
 */

/** Names are namespaced so two servers exporting `search` cannot collide — with each other or
 *  with a builtin. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * **An MCP tool's permission class is `exec`, always.**
 *
 * The harness cannot know what a third-party tool does: a server's `search` may read a database
 * or shell out. `read` would be a guess that fails open, and the permission system's whole value
 * is that the dangerous default is the safe one. `exec` means an MCP call needs an explicit
 * `--allow` or an interactive yes — which is the correct amount of friction for handing control
 * to someone else's binary.
 *
 * It also declares no `paths()`, so it can never satisfy a `cwdOnly` rule: there is no honest way
 * to say which files a remote tool will touch.
 */
export const MCP_PERMISSION = "exec" as const;

/** MCP servers describe inputs in JSON Schema; the loop only needs enough to reject a non-object. */
const PassthroughInput = z.record(z.unknown());

export interface McpToolOptions {
  client: McpClient;
  spec: McpToolSpec;
  /** Characters of tool output kept; a server returning a megabyte must not blow the context. */
  maxDisplayChars?: number;
}

export function mcpTool(opts: McpToolOptions): AnyTool {
  const maxDisplay = opts.maxDisplayChars ?? 20_000;
  const name = mcpToolName(opts.client.name, opts.spec.name);

  const tool: Tool<Record<string, unknown>, unknown> = {
    name,
    description:
      opts.spec.description ?? `${opts.spec.name} (provided by the ${opts.client.name} MCP server)`,
    inputSchema: PassthroughInput,
    // the server's own JSON Schema is what the MODEL is shown; converting it to zod and back
    // would degrade it to "an object", losing every field description the server wrote
    jsonSchema: opts.spec.inputSchema ?? { type: "object", properties: {} },
    permission: MCP_PERMISSION,
    execute: async (input, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      const result = await opts.client.callTool(opts.spec.name, input, ctx.signal);
      const rendered = renderContent(result.content);
      const truncated = rendered.length > maxDisplay;
      return {
        output: result,
        display: truncated ? `${rendered.slice(0, maxDisplay)}\n…(truncated)` : rendered,
        ...(truncated ? { truncated: true } : {}),
        // a server reporting a tool error is an EXPECTED failure: the model should see it and
        // adapt, exactly as it does for a non-zero exit from bash
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
  return tool as AnyTool;
}

export interface ConnectOptions {
  servers: McpClient[];
  onError?: (server: string, err: Error) => void;
}

/**
 * Starts every configured server and collects their tools.
 *
 * A server that fails to start costs its own tools and nothing else — one broken entry in a
 * config file must not stop the agent from running, the same way a failed hook or a failed
 * backend does not.
 */
export async function connectServers(opts: ConnectOptions): Promise<{ tools: AnyTool[]; connected: McpClient[] }> {
  const tools: AnyTool[] = [];
  const connected: McpClient[] = [];

  for (const client of opts.servers) {
    try {
      await client.start();
      for (const spec of await client.listTools()) tools.push(mcpTool({ client, spec }));
      connected.push(client);
    } catch (err) {
      opts.onError?.(client.name, err instanceof Error ? err : new Error(String(err)));
      await client.close().catch(() => {});
    }
  }
  return { tools, connected };
}
