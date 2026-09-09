import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMcpPins, connectServers, mcpDefinitionSnapshot, mcpDefinitionChange, mcpCatalogSnapshot,
  type McpClient, type McpToolSpec, type McpCatalog, type McpConnection } from "@agentkitai/agentrig-core";

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

it.each(["resource", "template", "prompt", "capabilities", "endpoint", "annotations", "outputSchema", "parameter-header"])("R15d %s changes require independent consent and an uncached post-consent check", async kind => {
  const pins = new FileMcpPins(root, "config");
  const catalog: McpCatalog = { tools: structuredClone(original), resources: [{ name: "doc", uri: "opaque:doc", description: "old" }],
    templates: [{ name: "item", uriTemplate: "opaque:{id}", description: "old" }], prompts: [{ name: "review", description: "old" }] };
  const identity = { endpoint: "https://fixture.test/mcp", capabilities: { resources: {}, tools: {}, prompts: {} } };
  const baseline = mcpCatalogSnapshot(catalog, identity);
  await pins.compareAndSet("remote", undefined, baseline);
  if (kind === "resource") catalog.resources[0]!.description = "new";
  if (kind === "template") catalog.templates[0]!.description = "new";
  if (kind === "prompt") catalog.prompts[0]!.description = "new";
  if (kind === "capabilities") identity.capabilities.resources = { subscribe: true };
  if (kind === "endpoint") identity.endpoint = "https://fixture.test/other";
  if (kind === "annotations") Object.assign(catalog.tools[0]!, { annotations: { readOnlyHint: true } });
  if (kind === "outputSchema") Object.assign(catalog.tools[0]!, { outputSchema: { type: "object", required: ["result"] } });
  if (kind === "parameter-header") catalog.tools[0]!.inputSchema = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } };
  const read = vi.fn(async () => ({ contents: [{ uri: "opaque:doc", text: "external" }] }));
  const list = vi.fn(async () => structuredClone(catalog));
  const client: McpConnection = { name: "remote", remote: true, identity, start: async () => {}, close: async () => {},
    listTools: async () => original, catalog: list, callTool: async () => ({ content: [] }), readResource: read,
    getPrompt: async () => ({ messages: [] }) };
  const denied = await connectServers({ servers: [client], pins });
  const tool = denied.tools.find(t => t.effects === "read-only")!;
  expect(tool.permission).toBe("net");
  await expect(tool.execute({ uri: "opaque:doc" }, context())).rejects.toThrow("not approved");
  expect(read).not.toHaveBeenCalled(); expect(await pins.read("remote")).toBe(baseline);
  const consent = vi.fn(async () => true);
  const accepted = await connectServers({ servers: [client], pins, onDefinitionChange: consent });
  list.mockClear();
  await accepted.tools.find(t => t.effects === "read-only")!.execute({ uri: "opaque:doc" }, context());
  expect(consent).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledOnce();
  expect(await pins.read("remote")).toBe(mcpCatalogSnapshot(catalog, identity));
});

it("R15d never replaces a v1 tool baseline silently when remote catalogue surfaces appear", async () => {
  const pins = new FileMcpPins(root, "config");
  const baseline = mcpDefinitionSnapshot(original); await pins.compareAndSet("example", undefined, baseline);
  const fake = server(original);
  Object.assign(fake.client, { remote: true, identity: { endpoint: "https://fixture.test/mcp", capabilities: { tools: {} } },
    catalog: async () => ({ tools: original, resources: [], templates: [], prompts: [] }) });
  const connected = await connectServers({ servers: [fake.client], pins });
  await expect(connected.tools[0]!.execute({}, context())).rejects.toThrow("not approved");
  expect(fake.callTool).not.toHaveBeenCalled(); expect(await pins.read("example")).toBe(baseline);
});

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

  it("reports a persisted approval, and reads a small pin without allocating the whole cap", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    const [file] = await readdir(root);
    // a real pin is kilobytes; the read used to allocate and zero 1 MiB on every tool call
    expect((await readFile(join(root, file!), "utf8")).length).toBeLessThan(1024 * 1024);
    const notices: string[] = [];
    const fake = server(changed);
    const connection = await connectServers({ servers: [fake.client], pins,
      onDefinitionChange: async () => true, onDefinitionNotice: (message) => notices.push(message) });
    await connection.tools[0]!.execute({}, context());
    // approving used to be the silent path: only refusals produced a receipt
    expect(notices.filter(message => message.includes("approved definition change persisted as the new baseline"))).toHaveLength(1);
    expect(notices.join("\n")).toContain("not a safety assessment");
    expect(await pins.read("example")).toBe(mcpDefinitionSnapshot(changed));
    // and the cap still binds, whatever the file claims about its own size
    await writeFile(join(root, file!), "a".repeat(1024 * 1024 + 1));
    await expect(pins.read("example")).rejects.toThrow("exceeds 1 MiB");
  });

  it("names the held lock and what actually clears it", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    const [file] = await readdir(root);
    const before = await readFile(join(root, file!), "utf8");
    await mkdir(join(root, `${file!}.lock`));
    const failure = await pins.compareAndSet("example", mcpDefinitionSnapshot(original), mcpDefinitionSnapshot(changed))
      .then(() => undefined, (error: Error) => error);
    expect(failure!.message).toContain("locked by another writer");
    expect(failure!.message).toContain("never stolen or expired");
    expect(failure!.message).toContain("no consent has been lost");
    // the refusal changes nothing, including the lock it refused to steal
    expect(await readFile(join(root, file!), "utf8")).toBe(before);
    expect(await readdir(root)).toContain(`${file!}.lock`);
  });

  it("CAS rejects stale approval and config scopes do not share trust", async () => {
    const pins = new FileMcpPins(root, "config");
    await pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(original));
    await expect(pins.compareAndSet("example", undefined, mcpDefinitionSnapshot(changed))).rejects.toThrow("changed during review");
    expect(await new FileMcpPins(root, "other config").read("example")).toBeUndefined();
  });
});
