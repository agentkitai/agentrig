import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  McpClient,
  connectServers,
  mcpTool,
  mcpToolName,
  renderContent,
  toToolSpec,
  type AnyTool,
} from "@agentkitai/agentrig-core";

/**
 * A fake MCP server process. Nothing is really spawned: `spawnFn` is injected, so these tests
 * exercise the protocol without a child process or a network.
 */
function fakeServer(handler: (req: { id: number; method: string; params: unknown }) => unknown | Promise<unknown>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });

  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line) as { id?: number; method: string; params: unknown };
      if (msg.id === undefined) continue; // a notification needs no reply
      void (async () => {
        try {
          const result = await handler({ id: msg.id!, method: msg.method, params: msg.params });
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        } catch (err) {
          stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: (err as Error).message } })}\n`,
          );
        }
      })();
    }
  });

  return { child, stdout, spawnFn: (() => child) as never };
}

const okHandler = (tools: unknown[]) => (req: { method: string; params: unknown }) => {
  if (req.method === "initialize") return { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } };
  if (req.method === "tools/list") return { tools };
  if (req.method === "tools/call") return { content: [{ type: "text", text: "called" }] };
  throw new Error(`unexpected ${req.method}`);
};

const SEARCH = { name: "search", description: "search things", inputSchema: { type: "object", properties: { q: { type: "string", description: "the query" } }, required: ["q"] } };

describe("McpClient", () => {
  it("handshakes, lists tools, and calls one", async () => {
    const { spawnFn } = fakeServer(okHandler([SEARCH]));
    const client = new McpClient({ name: "fake", command: "x" }, { spawnFn });
    await client.start();

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("search");

    const result = await client.callTool("search", { q: "hi" });
    expect(renderContent(result.content)).toBe("called");
    await client.close();
  });

  it("paginates tools/list", async () => {
    let page = 0;
    const { spawnFn } = fakeServer((req) => {
      if (req.method === "initialize") return { protocolVersion: "1" };
      if (req.method === "tools/list") {
        page += 1;
        return page === 1
          ? { tools: [{ name: "a" }], nextCursor: "more" }
          : { tools: [{ name: "b" }] };
      }
      throw new Error("no");
    });
    const client = new McpClient({ name: "f", command: "x" }, { spawnFn });
    await client.start();
    expect((await client.listTools()).map((t) => t.name)).toEqual(["a", "b"]);
    await client.close();
  });

  it("does not paginate forever when a server always returns a cursor", async () => {
    const errors: Error[] = [];
    const { spawnFn } = fakeServer((req) =>
      req.method === "initialize" ? { protocolVersion: "1" } : { tools: [{ name: "x" }], nextCursor: "always" },
    );
    const client = new McpClient({ name: "f", command: "x" }, { spawnFn, onError: (e) => errors.push(e) });
    await client.start();
    const tools = await client.listTools();
    expect(tools.length).toBeLessThanOrEqual(20);
    expect(errors.some((e) => e.message.includes("paginated past"))).toBe(true);
    await client.close();
  });

  it("surfaces a JSON-RPC error as a rejection", async () => {
    const { spawnFn } = fakeServer((req) => {
      if (req.method === "initialize") return { protocolVersion: "1" };
      throw new Error("tool exploded");
    });
    const client = new McpClient({ name: "f", command: "x" }, { spawnFn });
    await client.start();
    await expect(client.callTool("x", {})).rejects.toThrow(/tool exploded/);
    await client.close();
  });

  it("times out a server that never answers, rather than hanging the agent", async () => {
    const { spawnFn } = fakeServer((req) =>
      req.method === "initialize" ? { protocolVersion: "1" } : new Promise(() => {}),
    );
    const client = new McpClient({ name: "f", command: "x", timeoutMs: 40 }, { spawnFn });
    await client.start();
    await expect(client.callTool("x", {})).rejects.toThrow(/did not answer within 40ms/);
    await client.close();
  });

  it("ignores non-JSON on stdout instead of crashing the reader", async () => {
    const errors: Error[] = [];
    const { spawnFn, stdout } = fakeServer(okHandler([SEARCH]));
    const client = new McpClient({ name: "f", command: "x" }, { spawnFn, onError: (e) => errors.push(e) });
    await client.start();
    // a server that logs to stdout has broken the protocol; the client must survive it
    stdout.write("this is a log line, not JSON\n");
    await vi.waitFor(() => expect(errors.some((e) => e.message.includes("non-JSON"))).toBe(true));
    expect((await client.listTools())[0]!.name).toBe("search");
    await client.close();
  });

  it("rejects everything outstanding when the child dies", async () => {
    const { spawnFn, child } = fakeServer((req) =>
      req.method === "initialize" ? { protocolVersion: "1" } : new Promise(() => {}),
    );
    const client = new McpClient({ name: "f", command: "x" }, { spawnFn });
    await client.start();
    const pending = client.callTool("x", {});
    child.emit("exit", 1, null);
    // a dead child must not leave a request pending forever
    await expect(pending).rejects.toThrow(/exited/);
  });

  it("does not inherit the whole environment", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { child } = fakeServer(okHandler([]));
    const spawnFn = ((_cmd: string, _args: string[], o: Record<string, unknown>) => {
      calls.push(o);
      return child;
    }) as never;
    const client = new McpClient({ name: "f", command: "x", env: { TOKEN: "abc" } }, { spawnFn });
    await client.start();
    const env = calls[0]!.env as Record<string, string>;
    // a user pointing at a third-party binary should not hand it every secret in their shell
    expect(Object.keys(env).sort()).toEqual(["PATH", "TOKEN"]);
    await client.close();
  });

  it("refuses to use a closed client", async () => {
    const { spawnFn } = fakeServer(okHandler([]));
    const client = new McpClient({ name: "f", command: "x" }, { spawnFn });
    await client.start();
    await client.close();
    await expect(client.callTool("x", {})).rejects.toThrow(/closed/);
  });
});

describe("mcpTool", () => {
  const client = { name: "svr", callTool: async () => ({ content: [{ type: "text" as const, text: "result" }] }) };

  it("namespaces the tool so two servers cannot collide", () => {
    expect(mcpToolName("svr", "search")).toBe("mcp__svr__search");
    const tool = mcpTool({ client: client as never, spec: SEARCH });
    expect(tool.name).toBe("mcp__svr__search");
  });

  it("is exec, always — the harness cannot know what a third-party tool does", () => {
    const tool = mcpTool({ client: client as never, spec: SEARCH });
    expect(tool.permission).toBe("exec");
    // and declares no paths, so it can never satisfy a cwdOnly rule
    expect(tool.paths).toBeUndefined();
  });

  it("advertises the SERVER's schema, not a lossy zod round trip", () => {
    const tool = mcpTool({ client: client as never, spec: SEARCH });
    const spec = toToolSpec(tool);
    // the field description the server wrote is what the model needs to call it correctly
    expect(JSON.stringify(spec.inputSchema)).toContain("the query");
    expect((spec.inputSchema as { required?: string[] }).required).toEqual(["q"]);
  });

  it("renders text content and names what it cannot show", () => {
    expect(renderContent([{ type: "text", text: "hello" }])).toBe("hello");
    expect(renderContent([{ type: "image", mimeType: "image/png" }])).toContain("[image content omitted]");
  });

  it("passes a server-reported tool error through as an expected failure", async () => {
    const failing = {
      name: "svr",
      callTool: async () => ({ content: [{ type: "text" as const, text: "not found" }], isError: true }),
    };
    const tool = mcpTool({ client: failing as never, spec: SEARCH });
    const r = await tool.execute({ q: "x" }, { cwd: "/w", sessionId: "s", emit: () => {}, signal: new AbortController().signal });
    expect(r.isError).toBe(true);
    expect(r.display).toContain("not found");
  });

  it("truncates a huge response rather than blowing the context", async () => {
    const chatty = {
      name: "svr",
      callTool: async () => ({ content: [{ type: "text" as const, text: "z".repeat(50_000) }] }),
    };
    const tool = mcpTool({ client: chatty as never, spec: SEARCH, maxDisplayChars: 100 });
    const r = await tool.execute({ q: "x" }, { cwd: "/w", sessionId: "s", emit: () => {}, signal: new AbortController().signal });
    expect(r.display.length).toBeLessThan(200);
    expect(r.truncated).toBe(true);
  });
});

describe("connectServers", () => {
  it("a server that fails to start costs its own tools and nothing else", async () => {
    const good = fakeServer(okHandler([SEARCH]));
    const bad = fakeServer(() => {
      throw new Error("nope");
    });
    const errors: string[] = [];
    const { tools, connected } = await connectServers({
      servers: [
        new McpClient({ name: "broken", command: "x", timeoutMs: 50 }, { spawnFn: bad.spawnFn }),
        new McpClient({ name: "working", command: "y" }, { spawnFn: good.spawnFn }),
      ],
      onError: (server, err) => errors.push(`${server}: ${err.message}`),
    });

    expect(tools.map((t: AnyTool) => t.name)).toEqual(["mcp__working__search"]);
    expect(connected.map((c) => c.name)).toEqual(["working"]);
    expect(errors[0]).toContain("broken");
    for (const c of connected) await c.close();
  });
});
