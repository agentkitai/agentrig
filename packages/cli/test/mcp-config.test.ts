import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpConfig } from "../src/agent-builder.ts";
import { buildProgram } from "../src/program.ts";

/**
 * `readMcpConfig` is pure, async, and takes a path — the cheapest thing in the MCP diff to test,
 * and it had no coverage at all. A table over the shapes users actually have is what catches a
 * config that parses but yields nothing.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentrig-mcp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function config(contents: string): Promise<string> {
  const path = join(dir, "mcp.json");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("readMcpConfig", () => {
  it("accepts the Claude Code / Cursor shape", async () => {
    // `mcpServers` is what those tools write; accepting only `servers` meant a working config
    // produced a silently tool-less session
    const path = await config(JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "srv"] } } }));
    const servers = await readMcpConfig(path);
    expect(servers).toEqual([{ name: "fs", command: "npx", args: ["-y", "srv"] }]);
  });

  it("accepts the VS Code shape too", async () => {
    const path = await config(JSON.stringify({ servers: { fs: { command: "srv" } } }));
    expect(await readMcpConfig(path)).toEqual([{ name: "fs", command: "srv" }]);
  });

  it("carries env, cwd and timeout through when present", async () => {
    const path = await config(
      JSON.stringify({ mcpServers: { a: { command: "c", env: { T: "1" }, cwd: "/w", timeoutMs: 5000 } } }),
    );
    expect(await readMcpConfig(path)).toEqual([
      { name: "a", command: "c", env: { T: "1" }, cwd: "/w", timeoutMs: 5000 },
    ]);
  });

  it("fails loudly when NEITHER key is present, rather than yielding zero servers", async () => {
    const path = await config(JSON.stringify({ tools: {} }));
    await expect(readMcpConfig(path)).rejects.toThrow(/no "mcpServers" \(or "servers"\) key/);
  });

  it("reports a missing file by name", async () => {
    await expect(readMcpConfig(join(dir, "nope.json"))).rejects.toThrow(/could not read/);
  });

  it("reports malformed JSON rather than throwing a bare SyntaxError", async () => {
    const path = await config("{ not json");
    await expect(readMcpConfig(path)).rejects.toThrow(/could not read/);
  });

  it("rejects a server entry with no command", async () => {
    const path = await config(JSON.stringify({ mcpServers: { a: { args: ["x"] } } }));
    await expect(readMcpConfig(path)).rejects.toThrow(/not a valid MCP config/);
  });

  it("an empty server map is legal — a config with nothing configured yet", async () => {
    const path = await config(JSON.stringify({ mcpServers: {} }));
    expect(await readMcpConfig(path)).toEqual([]);
  });
});

describe("--mcp-config is registered where it is documented", () => {
  it("is available on run and on the default TUI command", () => {
    const program = buildProgram();
    const named = (n: string) => program.commands.find((c) => c.name() === n);
    for (const cmd of ["run", "tui"]) {
      const flags = named(cmd)!.options.map((o) => o.long);
      expect(flags, `${cmd} is missing --mcp-config`).toContain("--mcp-config");
    }
  });
});
