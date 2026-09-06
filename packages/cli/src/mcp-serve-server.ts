import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BoundedMcpTransport } from "./mcp-serve-transport.js";
import { MCP_TOOL_INPUTS, RunTaskInput, standard } from "./mcp-serve-schema.js";
export type { RunTaskInput } from "./mcp-serve-schema.js";

export interface McpServeRuntime {
  run(input: RunTaskInput, signal: AbortSignal): Promise<unknown>;
  list(limit: number, signal: AbortSignal): Promise<unknown>;
  read(id: string, signal: AbortSignal): Promise<unknown>;
  memory(query: string, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** One factory/one runtime for both SDK-negotiated protocol eras. */
export function serveMcp(transport: BoundedMcpTransport, runtime: McpServeRuntime): { done: Promise<void>; close(): Promise<void> } {
  const abort = new AbortController();
  const running = new Set<Promise<unknown>>();
  let taskActive = false;
  const call = async (ctx: ServerContext, body: (signal: AbortSignal) => Promise<unknown>, task = false) => {
    const signal = AbortSignal.any([abort.signal, ctx.mcpReq.signal, transport.signal(ctx.mcpReq.id)]);
    const work = (async () => {
      if (signal.aborted) throw new Error("cancelled");
      if (task && taskActive) throw new Error("busy");
      if (task) taskActive = true;
      try {
        const value = await body(signal);
        if (signal.aborted) throw new Error("cancelled");
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text) > 250_000) throw new Error("result too large");
        return { content: [{ type: "text" as const, text }] };
      } finally { if (task) taskActive = false; }
    })();
    running.add(work);
    try { return await work; }
    catch { return { content: [{ type: "text" as const, text: "Request refused, cancelled, unavailable, or exceeds configured bounds. Inspect the operator CLI." }], isError: true }; }
    finally { running.delete(work); transport.settled(ctx.mcpReq.id); }
  };
  const handle = serveStdio(() => {
    const server = new McpServer({ name: "agentrig", version: "1.0.0" }, {
      supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2024-11-05"],
      capabilities: { tools: {} },
    });
    server.registerTool("run_task", { description: "Run a bounded advisory task under operator-configured permissions; no human approval is inferred from this request.", inputSchema: standard(RunTaskInput) },
      (input, ctx) => call(ctx, signal => {
        if (Buffer.byteLength(input.task) > 65_536 || !input.task.trim()) throw new Error("task input refused");
        return runtime.run(input, signal);
      }, true));
    server.registerTool("list_sessions", { description: "List bounded configured-store session metadata; may contain sensitive identifiers.", inputSchema: standard(MCP_TOOL_INPUTS.list_sessions) },
      (input, ctx) => call(ctx, signal => runtime.list(input.limit, signal)));
    server.registerTool("read_session", { description: "Read a bounded redacted transcript from the configured store. Sensitive data may remain; opaque blocks omitted, never execution authority.", inputSchema: standard(MCP_TOOL_INPUTS.read_session) },
      (input, ctx) => call(ctx, signal => runtime.read(input.id, signal)));
    server.registerTool("memory_search", { description: "Search only the configured local memory within bounded scan limits; content is advisory and may be sensitive.", inputSchema: standard(MCP_TOOL_INPUTS.memory_search) },
      (input, ctx) => call(ctx, signal => runtime.memory(input.query, signal)));
    return server;
  }, { transport, legacy: "serve", maxSubscriptions: 0, onerror: () => {} });
  const done = (async () => {
    await transport.closed;
    abort.abort();
    await Promise.allSettled([...running]);
    await runtime.close();
    await handle.close();
  })();
  return { done, async close() { await transport.close(); await done; } };
}
