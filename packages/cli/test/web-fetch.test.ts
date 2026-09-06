import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelEvent, PermissionRequest } from "@agentkitai/agentrig-core";
import { buildAgent } from "../src/agent-builder.ts";

afterEach(() => { vi.unstubAllEnvs(); });
it.each(["default", "allow", "deny", "interactive"])("shipped CLI built-in fetch respects %s permission with real local GET", async mode => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-fetch-")); const methods: string[] = [];
  const server = createServer((req, res) => { methods.push(req.method!); res.setHeader("content-type", "text/html"); res.end("<p>CLI fetch</p>"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (address === null || typeof address === "string") throw Error("no listener");
    const url = `http://127.0.0.1:${address.port}/fixture`; const asks: PermissionRequest[] = [];
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
    const built = await buildAgent({ root, provider: "anthropic", model: "fixture", maxTurns: "2", maxTokensPerTurn: "100", repoMap: false,
      ...(mode === "allow" || mode === "deny" ? { allow: ["net"] } : {}), ...(mode === "deny" ? { deny: ["net"] } : {}) },
      mode === "interactive" ? { onAsk: async req => { asks.push(req); return "allow"; } } : {});
    let turn = 0;
    built.provider.stream = async function* (): AsyncIterable<ModelEvent> {
      if (turn++ === 0) yield { type: "tool_use", id: "fetch", name: "web_fetch", input: { url } };
      yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
    };
    await built.agent.run("fetch URL", { cwd: root }).done;
    expect(built.tools.find(tool => tool.name === "web_fetch")?.permission).toBe("net");
    expect(methods).toEqual(mode === "allow" || mode === "interactive" ? ["GET"] : []);
    expect(asks).toHaveLength(mode === "interactive" ? 1 : 0);
    if (mode === "interactive") expect(asks[0]).toMatchObject({ class: "net", input: { url } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
