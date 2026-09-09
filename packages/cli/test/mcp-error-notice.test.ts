import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { BoundedMcpTransport } from "../src/mcp-serve-transport.js";
import { serveMcp } from "../src/mcp-serve-server.js";

const capture = vi.hoisted(() => ({ onerror: undefined as undefined | ((error: Error) => void) }));
vi.mock("@modelcontextprotocol/server/stdio", async original => {
  const actual = await original<typeof import("@modelcontextprotocol/server/stdio")>();
  return { ...actual, serveStdio: (...args: Parameters<typeof actual.serveStdio>) => {
    capture.onerror = args[1]?.onerror;
    return actual.serveStdio(...args);
  } };
});
it("the installed SDK error callback reports once without reflecting remote error data", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = new BoundedMcpTransport(new PassThrough(), new PassThrough());
  const server = serveMcp(transport, { run: async () => null, list: async () => [], read: async () => null,
    memory: async () => null, close: async () => {} });
  try {
    expect(capture.onerror).toBeTypeOf("function");
    for (let i = 0; i < 100; i++) capture.onerror!(new Error("secret-token\u001b[31m".repeat(1000)));
    expect(error).toHaveBeenCalledExactlyOnceWith("MCP server protocol error; request handling may be unavailable. Inspect the operator configuration.");
  } finally { await server.close(); error.mockRestore(); }
});
