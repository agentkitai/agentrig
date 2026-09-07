import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildProgram } from "../src/program.js";
import { mcpLoginCommand } from "../src/mcp-login.js";
import * as core from "@agentkitai/agentrig-core";

it("mcp login negative flag overrides configured network true before the fake OAuth transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-login-network-"));
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(cwd);
  await writeFile(join(home, ".agentrig", "config.json"), JSON.stringify({ sandbox: "workspace-write", sandboxNetwork: true }));
  const config = join(root, "mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { fixture: { url: "https://fixture.invalid/mcp", oauth: { issuers: ["https://fixture.invalid/issuer"], clientId: "fixture" } } } }));
  const transport = vi.spyOn(core, "loginMcp").mockImplementation(async (_config, _store, options) => {
    if (!await options.authorize()) throw new Error("fake transport permission refused");
  });
  const notice = vi.fn();
  const make = () => buildProgram({ config: { cwd, home, env: {}, notice },
    mcpLogin: (name, opts, signal) => mcpLoginCommand(name, opts, signal, { home, notice }) }).exitOverride().configureOutput({ writeErr: () => {} });
  const argv = ["mcp", "login", "fixture", "--mcp-config", config, "--headless"];
  try {
    await expect(make().parseAsync([...argv, "--allow", "net", "--no-sandbox-network"], { from: "user" })).rejects.toThrow("requires explicit sandbox network policy");
    expect(transport).not.toHaveBeenCalled();
    await make().parseAsync([...argv, "--allow", "net"], { from: "user" });
    await make().parseAsync([...argv, "--allow", "net", "--sandbox-network"], { from: "user" });
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(make().parseAsync([...argv, "--sandbox-network", "--deny", "net"], { from: "user" })).rejects.toThrow("fake transport permission refused");
  } finally { transport.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it("actual mcp login argv reaches bounded OAuth without a provider, and explicit deny prevents all traffic", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentrig-mcp-login-"));
  let origin = ""; let traffic = 0;
  const server = createServer(async (req, res) => {
    traffic++;
    let body = ""; for await (const chunk of req) body += chunk;
    const path = req.url!;
    const result = path.includes("oauth-protected-resource") ? { resource: `${origin}/mcp`, authorization_servers: [`${origin}/issuer`] }
      : path.includes("oauth-authorization-server") || path.includes("openid-configuration") ? {
        issuer: `${origin}/issuer`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
      } : { access_token: "LOCAL-ONLY-TOKEN", token_type: "Bearer", refresh_token: "LOCAL-ONLY-REFRESH" };
    if (path === "/token") expect(new URLSearchParams(body).get("resource")).toBe(`${origin}/mcp`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("listener missing");
  origin = `http://127.0.0.1:${address.port}`;
  const path = join(home, "mcp.json");
  await writeFile(path, JSON.stringify({ mcpServers: { fixture: { url: `${origin}/mcp`, oauth: { issuers: [`${origin}/issuer`], clientId: "public" } } } }));
  const output: string[] = []; const callbacks: Promise<unknown>[] = [];
  const notice = (text: string): void => {
    output.push(text);
    if (!text.startsWith("Open this operator")) return;
    const authorization = new URL(text.split("\n")[1]!);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "local-code"); callback.searchParams.set("iss", `${origin}/issuer`);
    callbacks.push(fetch(callback));
  };
  const run = vi.fn(async () => { throw new Error("must not invoke agent/model"); });
  const make = () => buildProgram({ config: { cwd: home, home, env: {} }, run,
    mcpLogin: (name, opts, signal) => mcpLoginCommand(name, opts, signal, { home, notice }) });
  try {
    await expect(make().parseAsync(["mcp", "login", "fixture", "--mcp-config", path, "--headless", "--allow", "net", "--deny", "net"], { from: "user" })).rejects.toThrow("permission refused");
    expect(traffic).toBe(0);
    await make().parseAsync(["mcp", "login", "fixture", "--mcp-config", path, "--headless", "--allow", "net"], { from: "user" });
    await Promise.all(callbacks);
    expect(traffic).toBeGreaterThan(1); expect(run).not.toHaveBeenCalled();
    expect((await readdir(join(home, ".agentrig", "mcp-auth"))).filter(p => p.endsWith(".json"))).toHaveLength(1);
    expect(output.join("\n")).not.toContain("LOCAL-ONLY-TOKEN");
    expect(output.join("\n")).toContain("MCP login complete");
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); await rm(home, { recursive: true, force: true }); }
}, 15_000);
