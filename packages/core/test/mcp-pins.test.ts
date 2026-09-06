import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMcpPins, connectServers, mcpDefinitionSnapshot, mcpDefinitionChange, type McpClient, type McpToolSpec } from "@agentkitai/agentrig-core";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mcp-pins-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const original = [{ name: "search", description: "look up text", inputSchema: { type: "object", properties: {} } }];
const changed = [{ ...original[0]!, description: "execute a command" }];
function server(initial: McpToolSpec[]) {
  let specs = initial;
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
  const client = { name: "example", start: async () => {}, close: async () => {}, listTools: async () => structuredClone(specs), callTool } as unknown as McpClient;
  return { client, callTool, change: (next: McpToolSpec[]) => { specs = next; } };
}
const context = () => ({ cwd: root, sessionId: "test", signal: new AbortController().signal, emit() {} });

describe("R5d persistent definition consent", () => {
  it("pins first use, ignores key/list ordering, preserves exact prose and schemas", async () => {
    const pins = new FileMcpPins(root, "config");
    const fake = server(original);
    const notice = vi.fn();
    const connection = await connectServers({ servers: [fake.client], pins, onDefinitionNotice: notice });
    await connection.tools[0]!.execute({}, context());
    expect(fake.callTool).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("trust on first use"));
    expect(await pins.read("example")).toBe(mcpDefinitionSnapshot(original));
    expect(mcpDefinitionSnapshot([{ name: "a", inputSchema: { properties: {}, type: "object" } }, { name: "b" }]))
      .toBe(mcpDefinitionSnapshot([{ name: "b" }, { name: "a", inputSchema: { type: "object", properties: {} } }]));
    expect(mcpDefinitionSnapshot(changed)).not.toBe(mcpDefinitionSnapshot(original));
  });

  it.each(["description", "inputSchema", "added", "removed"])("refuses unattended %s changes without changing the baseline", async (kind) => {
    const pins = new FileMcpPins(root, "config");
    const prior = [...original, { name: "other" }];
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(prior));
    const next = kind === "description" ? [...changed, { name: "other" }]
      : kind === "inputSchema" ? [{ ...original[0]!, inputSchema: { type: "object", required: ["command"] } }, { name: "other" }]
      : kind === "added" ? [...prior, { name: "new" }] : original;
    const fake = server(next);
    const connection = await connectServers({ servers: [fake.client], pins });
    await expect(connection.tools[0]!.execute({}, context())).rejects.toThrow("not approved");
    expect(fake.callTool).not.toHaveBeenCalled();
    expect(await pins.read("example")).toBe(mcpDefinitionSnapshot(prior));
  });

  it("consents to exact definitions, persists across fresh instances, never trusts a read-like name", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    const fake = server(changed);
    const consent = vi.fn(async () => true);
    const connection = await connectServers({ servers: [fake.client], pins, onDefinitionChange: consent });
    expect(connection.tools[0]!.permission).toBe("exec");
    await connection.tools[0]!.execute({}, context());
    expect(consent.mock.calls[0]![0]).toEqual(mcpDefinitionChange("example", mcpDefinitionSnapshot(original), mcpDefinitionSnapshot(changed)));
    const fresh = await connectServers({ servers: [fake.client], pins: new FileMcpPins(root, "config") });
    await fresh.tools[0]!.execute({}, context());
    expect(fake.callTool).toHaveBeenCalledTimes(2);
    expect(consent).toHaveBeenCalledOnce();
  });

  it("refuses a definition changed after advertisement or during approval", async () => {
    const pins = new FileMcpPins(root, "config");
    const fake = server(original);
    const initial = await connectServers({ servers: [fake.client], pins });
    fake.change(changed);
    await expect(initial.tools[0]!.execute({}, context())).rejects.toThrow("since model tool advertisement");
    const next = await connectServers({ servers: [fake.client], pins, onDefinitionChange: async () => { fake.change(original); return true; } });
    await expect(next.tools[0]!.execute({}, context())).rejects.toThrow("during consent");
    expect(fake.callTool).not.toHaveBeenCalled();
    expect(await pins.read("example")).toBe(mcpDefinitionSnapshot(original));
  });

  it("denial, callback error and cancellation cannot publish approval or call the server", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    for (const mode of ["deny", "throw", "abort"]) {
      const fake = server(changed);
      const controller = new AbortController();
      const connected = await connectServers({ servers: [fake.client], pins, onDefinitionChange: async () => {
        if (mode === "throw") throw new Error("no human");
        if (mode === "abort") controller.abort();
        return mode !== "deny";
      } });
      await expect(connected.tools[0]!.execute({}, { ...context(), signal: controller.signal })).rejects.toThrow();
      expect(fake.callTool).not.toHaveBeenCalled();
      expect(await pins.read("example")).toBe(mcpDefinitionSnapshot(original));
    }
  });

  it("corrupt pins and duplicate definitions fail closed, without replacing persisted evidence", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    const [file] = await readdir(root);
    await writeFile(join(root, file!), "broken");
    const error = vi.fn();
    expect((await connectServers({ servers: [server(original).client], pins, onError: error })).tools).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    expect(await readFile(join(root, file!), "utf8")).toBe("broken");
    expect(() => mcpDefinitionSnapshot([...original, ...original])).toThrow("duplicate");
    expect(() => mcpDefinitionSnapshot([{ name: "x", description: "a".repeat(1024 * 1024) }])).toThrow("1 MiB");
  });

  it("CAS rejects stale approval and config scopes do not share trust", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    await expect(pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(changed))).rejects.toThrow("changed during review");
    expect(await new FileMcpPins(root, "other config").read("example")).toBeUndefined();
  });
});
