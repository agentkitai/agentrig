import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { McpCatalog, McpPromptArguments, McpPromptSpec, McpResourceSpec, McpResourceTemplateSpec,
  McpToolSpec, RemoteMcpToolSpec, ToolsCallResult, type McpConnection } from "./protocol.js";
import { McpHttpBoundary, RemoteMcpConfigSchema, type RemoteMcpConfig } from "./http.js";
import type { McpOAuthProvider } from "./auth.js";

export interface RemoteMcpOptions {
  /** Trusted host startup gate. Missing means deny; a URL in a file is not network consent. */
  authorizeStart?: () => Promise<boolean>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Trusted host auth implementation; CLI supplies operator-bound persisted OAuth only. */
  oauth?: McpOAuthProvider;
}

export class RemoteMcpClient implements McpConnection {
  readonly remote = true;
  readonly name: string;
  private readonly client = new Client({ name: "agentrig", version: "0.0.0" }, {
    capabilities: {}, versionNegotiation: { mode: "auto", probe: { maxRetries: 0 } },
    defaultCacheTtlMs: 0,
  });
  private readonly http: McpHttpBoundary;
  private readonly transport: StreamableHTTPClientTransport;
  private started = false;
  private listedTools: McpToolSpec[] = [];
  constructor(readonly config: RemoteMcpConfig, private readonly opts: RemoteMcpOptions = {}) {
    RemoteMcpConfigSchema.parse(config); this.name = config.name;
    this.http = new McpHttpBoundary(config, opts.fetch);
    this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: this.http.fetch, onInsufficientScope: "throw",
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      ...(opts.oauth ? { authProvider: {
        token: async () => opts.oauth!.tokens()?.access_token,
        onUnauthorized: async () => opts.oauth!.refresh(this.http, opts.signal),
      } } : {}),
    });
  }
  get identity(): unknown {
    return { endpoint: new URL(this.config.url).href, era: this.client.getProtocolEra(),
      capabilities: this.client.getServerCapabilities() ?? {} };
  }
  async start(): Promise<void> {
    if (this.started) throw new Error("MCP already started");
    if (await this.opts.authorizeStart?.() !== true) throw new Error("MCP startup network permission refused");
    this.started = true;
    await this.owned("startup", async signal => {
      // The SDK's pre-Protocol discovery probe has its own reply timer. Closing the owned
      // transport wakes that probe immediately when the caller cancels before negotiation.
      const abort = (): void => { void this.transport.close().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try { signal.throwIfAborted(); await this.client.connect(this.transport, { signal, timeout: 30_000 }); signal.throwIfAborted(); }
      finally { signal.removeEventListener("abort", abort); }
    }, this.opts.signal);
  }
  private async owned<T>(operation: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try { return await this.http.operation(fn, signal); }
    catch {
      // SDK/remote errors may include OAuth error_description or credential-bearing metadata.
      // Neither diagnostics nor canonical tool events receive those raw error strings.
      if (signal?.aborted) throw new Error("MCP operation cancelled");
      throw new Error(`MCP ${operation} unavailable (protocol, authorization or bounded network failure); explicit login may be required`);
    }
  }
  private async pages<T>(method: "tools/list" | "resources/list" | "resources/templates/list" | "prompts/list",
    key: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
    const out: T[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      // Raw public request avoids SDK auto-pagination/cache. Every page is validated here.
      const raw: unknown = await this.client.request({ method, params: cursor === undefined ? {} : { cursor } }, { signal, timeout: 30_000 });
      const parsed = z.object({ [key]: z.array(schema), nextCursor: z.string().max(4096).optional() }).parse(raw);
      out.push(...parsed[key] as T[]);
      if (out.length > 256 || Buffer.byteLength(JSON.stringify(out)) > 1_048_576) throw new Error("MCP list exceeds bound");
      const next = parsed.nextCursor;
      if (typeof next !== "string") return out;
      if (cursors.has(next)) throw new Error("MCP repeated pagination cursor");
      cursors.add(next); cursor = next;
    }
    throw new Error("MCP incomplete list after 20 pages");
  }
  async catalog(signal?: AbortSignal): Promise<McpCatalog> {
    return this.owned("catalogue", async s => {
      const caps = this.client.getServerCapabilities() ?? {};
      const tools = caps.tools ? await this.pages("tools/list", "tools", RemoteMcpToolSpec, s) : [];
      if (this.client.getProtocolEra() === "modern") for (const tool of tools) validateHeaderAnnotations(tool.inputSchema);
      const resources = caps.resources ? await this.pages("resources/list", "resources", McpResourceSpec, s) : [];
      const templates = caps.resources ? await this.pages("resources/templates/list", "resourceTemplates", McpResourceTemplateSpec, s) : [];
      const prompts = caps.prompts ? await this.pages("prompts/list", "prompts", McpPromptSpec, s) : [];
      const result = McpCatalog.parse({ tools, resources, templates, prompts });
      if (tools.length + resources.length + templates.length + prompts.length > 256 || Buffer.byteLength(JSON.stringify(result)) > 1_048_576)
        throw new Error("MCP combined catalog exceeds bound");
      this.listedTools = structuredClone(result.tools);
      return result;
    }, signal);
  }
  async listTools(signal?: AbortSignal): Promise<McpToolSpec[]> { return (await this.catalog(signal)).tools; }
  async callTool(name: string, args: unknown, signal?: AbortSignal, definition?: McpToolSpec): Promise<ToolsCallResult> {
    const spec = RemoteMcpToolSpec.parse(definition ?? this.listedTools.find(tool => tool.name === name));
    if (spec.name !== name) throw new Error("MCP tool definition mismatch");
    if (this.client.getProtocolEra() === "modern") validateHeaderAnnotations(spec.inputSchema);
    // An explicit pinned definition enables SDK parameter-header mirroring without its cache
    // lookup or HeaderMismatch re-list/retry, which would bypass our independent pin gate.
    type SdkTool = NonNullable<NonNullable<Parameters<Client["callTool"]>[1]>["toolDefinition"]>;
    return this.owned("tool call", async s => ToolsCallResult.parse(await this.client.callTool({ name, arguments: args as Record<string, unknown> },
      { signal: s, timeout: 30_000, toolDefinition: spec as SdkTool })), signal);
  }
  async readResource(uri: string, signal?: AbortSignal): Promise<{ contents: unknown[] }> {
    return this.owned("resource read", async s => z.object({ contents: z.array(z.unknown()).max(256) }).parse(
      await this.client.request({ method: "resources/read", params: { uri } }, { signal: s, timeout: 30_000 })), signal);
  }
  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<{ messages: unknown[] }> {
    McpPromptArguments.parse(args);
    return this.owned("prompt read", async s => z.object({ messages: z.array(z.unknown()).max(256) }).parse(
      await this.client.request({ method: "prompts/get", params: { name, arguments: args } }, { signal: s, timeout: 30_000 })), signal);
  }
  async close(): Promise<void> {
    try {
      if (this.transport.sessionId) await this.http.operation(() => this.transport.terminateSession(), undefined, 2000).catch(() => {});
    } finally { await this.client.close().catch(() => {}); await this.http.close(); }
  }
}

/** Small schema admission check for SEP-2243; actual header encoding/mirroring is SDK-owned.
 * Reject the entire malformed catalogue rather than accidentally executing an unpinned subset.
 */
function validateHeaderAnnotations(schema: unknown): void {
  const names = new Set<string>(); let nodes = 0;
  const walk = (node: unknown, reachable: boolean, parameter: boolean, depth: number): void => {
    if (node === null || typeof node !== "object") return;
    if (++nodes > 4096 || depth > 32) throw new Error("MCP tool schema traversal bound");
    if (Array.isArray(node)) { for (const value of node) walk(value, false, false, depth + 1); return; }
    const object = node as Record<string, unknown>;
    if (Object.hasOwn(object, "x-mcp-header")) {
      const header = object["x-mcp-header"];
      if (!reachable || !parameter || !["string", "boolean", "integer"].includes(String(object.type)) ||
        typeof header !== "string" || header.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
        names.has(header.toLowerCase()) || Object.hasOwn(object, "$ref")) throw new Error("MCP invalid parameter-header annotation");
      names.add(header.toLowerCase());
    }
    for (const [key, value] of Object.entries(object)) {
      if (key === "properties" && reachable && value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const child of Object.values(value)) walk(child, true, true, depth + 1);
      } else walk(value, false, false, depth + 1);
    }
  };
  walk(schema, true, false, 0);
}
