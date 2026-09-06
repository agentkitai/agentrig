import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loginMcp, McpCredentialStore, McpHttpBoundary, McpOAuthProvider } from "../src/mcp/index.js";

it.each([true, false])("binds actual loopback OAuth code/PKCE/issuer/resource and refresh (registered client=%s)", async registered => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-mcp-oauth-"));
  let origin = "";
  let authUrl: URL | undefined;
  const tokens: URLSearchParams[] = [];
  let registrations = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, origin).pathname;
    let body = ""; for await (const chunk of req) body += chunk;
    let result: unknown;
    if (path.includes("oauth-protected-resource")) result = { resource: `${origin}/mcp`, authorization_servers: [`${origin}/issuer`], scopes_supported: ["mcp"] };
    else if (path.includes("oauth-authorization-server") || path.includes("openid-configuration")) result = {
      issuer: `${origin}/issuer`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
    };
    else if (path === "/register") { registrations++; result = { ...JSON.parse(body), client_id: "public-fixture" }; }
    else if (path === "/token") {
      const params = new URLSearchParams(body); tokens.push(params);
      result = { access_token: params.get("grant_type") === "refresh_token" ? "rotated-fixture" : "initial-fixture", token_type: "Bearer", refresh_token: "refresh-fixture", scope: "mcp", expires_in: 3600 };
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("listener missing");
  origin = `http://127.0.0.1:${address.port}`;
  const config = { name: "oauth", url: `${origin}/mcp`, oauth: { issuers: [`${origin}/issuer`], ...(registered ? { clientId: "public-fixture" } : {}) } };
  const store = new McpCredentialStore(root, config.url);
  try {
    await loginMcp(config, store, { authorize: async () => true, onAuthorizationUrl: async url => {
      authUrl = new URL(url);
      const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authUrl.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("iss", `${origin}/issuer`);
      expect((await fetch(callback)).status).toBe(200);
    } });
    expect(authUrl?.origin).toBe(origin);
    expect(authUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(tokens[0]?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(tokens[0]?.get("resource")).toBe(config.url);
    expect(tokens[0]?.get("code")).toBe("fixture-code");
    expect(registrations).toBe(registered ? 0 : 1);
    const original = await readFile(store.path, "utf8");
    for (const mismatch of ["state", "iss"] as const) {
      await expect(loginMcp(config, store, { authorize: async () => true, onAuthorizationUrl: async url => {
        const authorization = new URL(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", mismatch === "state" ? "wrong-state" : authorization.searchParams.get("state")!);
        callback.searchParams.set("code", "must-not-exchange");
        callback.searchParams.set("iss", mismatch === "iss" ? `${origin}/wrong-issuer` : `${origin}/issuer`);
        callback.searchParams.set("error_description", "SECRET-MUST-NOT-ESCAPE");
        await fetch(callback);
      } })).rejects.toThrow(/^MCP login failed or cancelled;/);
      expect(tokens).toHaveLength(1);
      expect(await readFile(store.path, "utf8")).toBe(original);
    }
    expect(JSON.parse(await readFile(store.path, "utf8")).issuer).toBe(`${origin}/issuer`);
    const provider = new McpOAuthProvider(config, store);
    await provider.load();
    const http = new McpHttpBoundary(config);
    try { await provider.refresh(http); } finally { await http.close(); }
    expect(tokens[1]?.get("grant_type")).toBe("refresh_token");
    expect(tokens[1]?.get("resource")).toBe(config.url);
    expect(provider.tokens()?.access_token).toBe("rotated-fixture");
    expect(registrations).toBe(registered ? 0 : 3); // each explicit fresh login may register; refresh never does
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); await rm(root, { recursive: true, force: true }); }
}, 15_000);
