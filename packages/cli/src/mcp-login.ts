import { homedir } from "node:os";
import { join } from "node:path";
import { loginMcp, McpCredentialStore, type Decision, type PermissionRequest } from "@agentkitai/agentrig-core";
import { readMcpConfig } from "./agent-builder.js";
import { askInteractively, buildPermissionPolicy } from "./run.js";

export interface McpLoginOptions {
  mcpConfig: string;
  allow?: string[];
  deny?: string[];
  headless?: boolean;
  sandbox?: string;
  sandboxNetwork?: boolean;
}

/** Operator-only sign-in. No provider construction, model request, or implicit browser launch. */
export async function mcpLoginCommand(name: string, opts: McpLoginOptions, signal: AbortSignal,
  deps: { home?: string; notice?: (text: string) => void;
    ask?: (request: PermissionRequest) => Promise<Exclude<Decision, "ask">> } = {}): Promise<void> {
  const config = (await readMcpConfig(opts.mcpConfig)).find(c => c.name === name);
  if (!config || !("url" in config) || !config.oauth) throw new Error("MCP login requires a configured remote OAuth server");
  if (opts.sandbox !== undefined && opts.sandbox !== "none" && opts.sandboxNetwork !== true)
    throw new Error("MCP login trusted host fetch requires explicit sandbox network policy");
  const notice = deps.notice ?? console.error;
  const policy = buildPermissionPolicy(opts);
  const request: PermissionRequest = { tool: `mcp_login_${name}`, class: "net", cwd: process.cwd(),
    input: { endpoint: config.url, issuers: config.oauth.issuers, endpointOrigins: config.oauth.endpointOrigins ?? [], operation: "operator OAuth discovery, registration and token exchange" } };
  await loginMcp(config, new McpCredentialStore(join(deps.home ?? homedir(), ".agentrig", "mcp-auth"), new URL(config.url).href), {
    signal,
    authorize: async () => {
      signal.throwIfAborted();
      notice(`MCP login endpoint: ${config.url}; approved issuers: ${JSON.stringify(config.oauth!.issuers)}; trusted host HTTP, not OS-contained`);
      let decision = await policy.decide(request);
      if (decision === "ask") decision = deps.ask ? await deps.ask(request)
        : opts.headless || !process.stdin.isTTY ? "deny" : await askInteractively(request, signal);
      notice(`MCP login net: ${decision}`);
      return decision === "allow";
    },
    onAuthorizationUrl: url => notice(`Open this operator sign-in URL in your browser (valid for this bounded flow only):\n${url}`),
  });
  notice("MCP login complete. Credentials are stored separately as owner-restricted plaintext, not an encrypted keychain.");
}
