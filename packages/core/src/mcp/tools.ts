import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnyTool, Tool, ToolContext, ToolResult } from "../tool.js";
import { bound } from "../tools/shared.js";
import type { McpClient } from "./client.js";
import { renderContent, type McpToolSpec } from "./protocol.js";

/**
 * Turns an MCP server's tools into ordinary `Tool`s, which is the whole point: once adapted they
 * go through the same permission policy, the same hooks, and the same event log as a builtin.
 * Nothing downstream needs to know MCP exists.
 *
 * Two decisions here are load-bearing and neither is obvious.
 */

/** Anthropic's constraint, and the strictest of the providers we target. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME = 64;

/**
 * Namespaced so two servers exporting `search` cannot collide — with each other or with a
 * builtin — and **sanitised**, because both halves are user- or server-controlled strings that go
 * straight into the provider payload.
 *
 * A server named `my server` in a config file, a tool named `a.b` (common in real servers), or a
 * long name from an enterprise server all produce a tool name the provider rejects — and the
 * rejection is a 400 on *every* model request, so one bad entry killed the whole session rather
 * than costing only its own tools. Disallowed characters are mapped and over-long names are
 * truncated with a hash of the original, which also closes the `__`-delimiter collision (two
 * different server/tool splits could otherwise compose to one name).
 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanServer = clean(server);
  const cleanTool = clean(tool);
  const full = `mcp__${cleanServer}__${cleanTool}`;

  // A name is unambiguous only when the composition is reversible: sanitising must have changed
  // nothing, and neither half may contain the `__` delimiter (server "a__b"/tool "c" and server
  // "a"/tool "b__c" both compose to `mcp__a__b__c`, and the registry silently kept one while
  // shipping both specs). Otherwise a hash of the ORIGINAL pair disambiguates.
  const reversible =
    cleanServer === server && cleanTool === tool && !server.includes("__") && !tool.includes("__");
  if (reversible && full.length <= MAX_NAME && TOOL_NAME.test(full)) return full;

  const digest = createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 8);
  return `${full.slice(0, MAX_NAME - 9)}_${digest}`;
}

/**
 * A server's `inputSchema` is advertised to the model verbatim, so it has to be something the
 * provider will accept and something the model can act on. Anthropic requires an object schema;
 * a server declaring `{"type":"string"}` would both be rejected and, if accepted, tell the model
 * to send a string that `inputSchema`'s zod check then refuses forever — the two sides disagreeing
 * by construction.
 */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const empty = { type: "object", properties: {} };
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return empty;
  const obj = { ...(schema as Record<string, unknown>) };
  // providers reject or ignore it, and it adds bytes to every request
  delete obj.$schema;
  if (obj.type !== "object") return empty;
  if (obj.properties === undefined) obj.properties = {};
  return obj;
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
    jsonSchema: normalizeSchema(opts.spec.inputSchema),
    permission: MCP_PERMISSION,
    execute: async (input, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      const result = await opts.client.callTool(opts.spec.name, input, ctx.signal);
      const rendered = renderContent(result.content);
      const bounded = bound(rendered, maxDisplay);
      return {
        output: result,
        display: bounded.display,
        ...(bounded.truncated
          ? { truncated: true, fullDisplay: rendered, displayPrefixChars: bounded.shown }
          : {}),
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
