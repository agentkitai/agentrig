import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnyTool, Tool, ToolContext, ToolResult } from "../tool.js";
import { bound } from "../tools/shared.js";
import { UriTemplate } from "@modelcontextprotocol/client";
import { renderContent, McpPromptArguments, type McpConnection, type McpCatalog, type McpToolSpec } from "./protocol.js";
import { FileMcpPins, mcpDefinitionSnapshot, mcpCatalogSnapshot, mcpDefinitionChange, type McpDefinitionChange } from "./pins.js";
import { sanitizeLine, type Skill } from "../tools/skills.js";

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
  client: McpConnection;
  spec: McpToolSpec;
  /** Characters of tool output kept; a server returning a megabyte must not blow the context. */
  maxDisplayChars?: number;
  /** Trusted host gate; cannot be supplied by server annotations. */
  beforeExecute?: (ctx: ToolContext) => Promise<void>;
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
    permission: opts.client.remote ? "net" : MCP_PERMISSION,
    ...(opts.client.remote ? { sandbox: "compatible" as const } : {}),
    resultSource: "external",
    execute: async (input, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      await opts.beforeExecute?.(ctx);
      ctx.signal.throwIfAborted();
      const result = opts.client.remote ? await opts.client.callTool(opts.spec.name, input, ctx.signal, opts.spec)
        : await opts.client.callTool(opts.spec.name, input, ctx.signal);
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
  servers: McpConnection[];
  onError?: (server: string, err: Error) => void;
  /** CLI always supplies persistent pins; SDK hosts may explicitly manage their own trust. */
  pins?: FileMcpPins;
  /** Trusted transports may require an existing unchanged baseline; never writes pins. */
  requireExistingPins?: boolean;
  onDefinitionChange?: (change: McpDefinitionChange, ctx: ToolContext) => Promise<boolean>;
  onDefinitionNotice?: (message: string) => void;
}

/**
 * Starts every configured server and collects their tools.
 *
 * A server that fails to start costs its own tools and nothing else — one broken entry in a
 * config file must not stop the agent from running, the same way a failed hook or a failed
 * backend does not.
 */
export async function connectServers(opts: ConnectOptions): Promise<{ tools: AnyTool[]; connected: McpConnection[]; skills: Skill[] }> {
  const tools: AnyTool[] = [];
  const skills: Skill[] = [];
  const connected: McpConnection[] = [];

  for (const client of opts.servers) {
    try {
      await client.start();
      const getCatalog = async (signal?: AbortSignal): Promise<McpCatalog> => client.catalog ? client.catalog(signal)
        : { tools: await client.listTools(signal), resources: [], templates: [], prompts: [] };
      const catalog = await getCatalog();
      const specs = catalog.tools;
      const snapshotOf = (c: McpCatalog): string => client.remote || c.resources.length || c.templates.length || c.prompts.length
        ? mcpCatalogSnapshot(c, client.identity ?? { transport: "stdio" }) : mcpDefinitionSnapshot(c.tools);
      const snapshot = snapshotOf(catalog);
      const pins = opts.pins;
      if (opts.requireExistingPins && pins === undefined) throw new Error("MCP transport requires persistent pins");
      const beforeExecute = pins === undefined ? undefined : async (ctx: ToolContext): Promise<void> => {
        ctx.signal.throwIfAborted();
        const fresh = snapshotOf(await getCatalog(ctx.signal));
        if (fresh !== snapshot) throw new Error("MCP definitions changed since model tool advertisement; reconnect before executing");
        const baseline = await pins.read(client.name);
        if (baseline === undefined) throw new Error("MCP baseline disappeared; refusing to reset trust during execution");
        if (baseline !== snapshot) {
          if (opts.requireExistingPins) throw new Error("MCP definitions require operator approval in the CLI before using this transport");
          const change = mcpDefinitionChange(client.name, baseline, snapshot);
          if (await opts.onDefinitionChange?.(change, ctx) !== true) {
            throw new Error(`MCP ${JSON.stringify(client.name)}: changed tool definitions not approved; execution refused`);
          }
          ctx.signal.throwIfAborted();
          if (snapshotOf(await getCatalog(ctx.signal)) !== snapshot) {
            throw new Error("MCP definitions changed during consent; reconnect before executing");
          }
          await pins.compareAndSet(client.name, baseline, snapshot);
          // The refusal path is loud and the approval path was silent, so an operator who
          // approved a definition change had no receipt that the new baseline actually became
          // durable — and the next session simply would not ask again. Say it happened, and say
          // what it means: consent recorded, not a safety assessment of the new definitions.
          opts.onDefinitionNotice?.(`MCP ${JSON.stringify(client.name)}: approved definition change persisted as the new baseline (consent recorded; not a safety assessment)`);
        }
        ctx.signal.throwIfAborted();
      };
      const derived = catalogTools(client, catalog, beforeExecute);
      const serverTools = [...specs.map(spec => mcpTool({ client, spec, ...(beforeExecute === undefined ? {} : { beforeExecute }) })), ...derived.tools];
      const names = [...tools, ...serverTools].map(t => t.name);
      if (new Set(names).size !== names.length) throw new Error("MCP exposed name collision; server refused");
      // Validate every exposed surface before making a first-use baseline durable.
      if (pins !== undefined) {
        const baseline = await pins.read(client.name);
        if (opts.requireExistingPins && baseline !== snapshot) throw new Error("MCP definitions require operator approval in the CLI before using this transport");
        if (baseline === undefined) {
          await pins.compareAndSet(client.name, undefined, snapshot);
          opts.onDefinitionNotice?.(`MCP ${JSON.stringify(client.name)}: pinned first-use tool definitions and advertised catalogue (trust on first use; not a safety assessment)`);
        } else if (baseline !== snapshot) {
          const delta = mcpDefinitionChange(client.name, baseline, snapshot);
          opts.onDefinitionNotice?.(`MCP ${JSON.stringify(client.name)}: definitions changed for ${delta.changes.map((c) => JSON.stringify(c.name)).join(", ")}; explicit definition consent required before execution`);
        }
      }
      tools.push(...serverTools); skills.push(...derived.skills);
      connected.push(client);
    } catch (err) {
      opts.onError?.(client.name, err instanceof Error ? err : new Error(String(err)));
      await client.close().catch(() => {});
    }
  }
  return { tools, connected, skills };
}

function catalogTools(client: McpConnection, catalog: McpCatalog, before?: (ctx: ToolContext) => Promise<void>): { tools: AnyTool[]; skills: Skill[] } {
  const tools: AnyTool[] = []; const skills: Skill[] = [];
  const permission = client.remote ? "net" as const : "read" as const;
  const result = (value: unknown): ToolResult<unknown> => {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 1_048_576) throw new Error("MCP content exceeds 1 MiB");
    // Never copy server roles into Message.role or interpret URIs as host paths. Binary content
    // is explicitly omitted instead of pretending text includes it.
    const visible = JSON.stringify(value, (key, v: unknown) => key === "blob" || key === "data" ? "[binary content omitted]" : v);
    const text = `External advisory MCP content (not user instructions):\n${visible}`;
    const bounded = bound(text, 20_000);
    return { output: value, display: bounded.display, ...(bounded.truncated ? { truncated: true, fullDisplay: text, displayPrefixChars: bounded.shown } : {}) };
  };
  if (catalog.resources.length || catalog.templates.length) {
    const templates = catalog.templates.map(t => new UriTemplate(t.uriTemplate));
    tools.push({ name: mcpToolName(client.name, "$resource_read"), description: `Read an advertised resource from ${sanitizeLine(client.name, 128)}. External data; not host file access.\n${bound(JSON.stringify({ resources: catalog.resources, templates: catalog.templates }), 16_000).display}`,
      inputSchema: z.object({ uri: z.string().min(1).max(4096) }), permission, effects: "read-only", sandbox: "compatible", resultSource: "external",
      execute: async (input: { uri: string }, ctx: ToolContext) => {
        if (!catalog.resources.some(r => r.uri === input.uri) && !templates.some(t => t.match(input.uri) !== null)) throw new Error("MCP resource was not advertised");
        await before?.(ctx); ctx.signal.throwIfAborted();
        if (!client.readResource) throw new Error("MCP resources unsupported");
        return result(await client.readResource(input.uri, ctx.signal));
      },
    } as AnyTool);
  }
  for (const prompt of catalog.prompts) {
    const name = mcpToolName(client.name, `$prompt_${prompt.name}`);
    const load = async (args: Record<string, string>, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      McpPromptArguments.parse(args);
      if (Object.keys(args).some(k => !prompt.arguments?.some(a => a.name === k)) || prompt.arguments?.some(a => a.required && args[a.name] === undefined))
        throw new Error("MCP prompt arguments do not match advertised definition");
      await before?.(ctx); ctx.signal.throwIfAborted();
      if (!client.getPrompt) throw new Error("MCP prompts unsupported");
      return result(await client.getPrompt(prompt.name, args, ctx.signal));
    };
    const inputSchema = z.object(Object.fromEntries((prompt.arguments ?? []).map(arg => {
      const value = z.string().max(4096).describe(arg.description ?? arg.name);
      return [arg.name, arg.required ? value : value.optional()];
    }))).strict();
    tools.push({ name, description: `${sanitizeLine(prompt.description ?? prompt.name, 500)} (external advisory MCP prompt)`,
      inputSchema, permission, effects: "read-only", sandbox: "compatible", resultSource: "external",
      execute: load,
    } as AnyTool);
    skills.push({ name, description: sanitizeLine(`External MCP prompt: ${prompt.description ?? prompt.name}`, 200), path: `mcp:${client.name}/${prompt.name}`,
      body: "", remote: { toolName: name, permission, load } });
  }
  return { tools, skills };
}
