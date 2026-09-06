import type { Command } from "commander";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { McpServerConfig, Session } from "@agentkitai/agentrig-core";
import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { unionRetrieve } from "@agentkitai/agentrig-memory";
import { supervise } from "@agentkitai/agentrig-supervisor";
import { buildAgent, parseBudget, readMcpConfig, type AgentBuildOptions, type BuiltAgent } from "./agent-builder.js";
import { loadRunConfig, type LoadRunConfigOptions } from "./config.js";
import { resolveProjectBoundary } from "./trust.js";
import { checkpointRestorer, parseSoft, parseTurnsRemaining, supervisorOptions, validateAbortRestores, type SupervisorFlags } from "./run.js";
import { TuiController } from "./tui/controller.js";
import { acpTransport } from "./acp-transport.js";
import { serveAcp } from "./acp-server.js";

export type AcpFlags = AgentBuildOptions & SupervisorFlags & { trust?: boolean; profile?: string; headless?: boolean; json?: boolean; verbose?: boolean };
export interface AcpDependencies {
  config?: LoadRunConfigOptions;
  input?: Readable;
  output?: Writable;
  build?: typeof buildAgent;
}
function normalizedEnv(env: Record<string, string>): string {
  return JSON.stringify(Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
/** Exact transport configuration matching, never command/name heuristics or new host authority. */
export function matchAcpMcp(request: NewSessionRequest, trusted: McpServerConfig[]): McpServerConfig[] {
  if (request.mcpServers.length > 8) throw new Error("too many MCP servers");
  const names = new Set<string>();
  return request.mcpServers.map(server => {
    if ("type" in server || !isAbsolute(server.command) || server.command.length > 4096 || names.has(server.name) ||
      server.name.length > 128 || server.args.length > 128 || server.env.length > 128) throw new Error("MCP transport configuration refused");
    names.add(server.name);
    const configured = trusted.find(candidate => candidate.name === server.name);
    if (configured === undefined) throw new Error("MCP transport configuration is not trusted");
    const env: Record<string, string> = {};
    for (const item of server.env) {
      if (Object.hasOwn(env, item.name) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name) || item.value.length > 16_384) throw new Error("MCP environment refused");
      Object.defineProperty(env, item.name, { value: item.value, enumerable: true });
    }
    if (server.args.some(arg => arg.length > 16_384) || configured.command !== server.command ||
      JSON.stringify(configured.args ?? []) !== JSON.stringify(server.args) || normalizedEnv(configured.env ?? {}) !== normalizedEnv(env)) throw new Error("MCP transport configuration does not match trusted configuration");
    return { ...configured, cwd: resolve(request.cwd, configured.cwd ?? ".") };
  });
}

export async function startAcp(command: Command, flags: AcpFlags, dependencies: AcpDependencies = {}): Promise<void> {
  if (flags.json || flags.verbose) throw new Error("ACP stdout is protocol-only; use the negotiated raw-event extension instead of --json/--verbose");
  const launchCwd = await realpath(dependencies.config?.cwd ?? process.cwd());
  const home = dependencies.config?.home ?? homedir();
  const transport = acpTransport(dependencies.input ?? process.stdin, dependencies.output ?? process.stdout);
  const notice = () => console.error("ACP integration notice: inspect the operator CLI for configuration details.");
  const server = serveAcp(transport.stream, { closeTransport: transport.close, reserveOutput: transport.reserve,
    createSession: async (request, observe) => {
      const [launchBoundary, sessionBoundary] = await Promise.all([resolveProjectBoundary(launchCwd, home), resolveProjectBoundary(request.cwd, home)]);
      const defaults = { ...flags, trust: flags.trust === true && launchBoundary.projectRoot === sessionBoundary.projectRoot };
      const loaded = await loadRunConfig(command, defaults as unknown as Record<string, unknown>, {
        ...dependencies.config, cwd: request.cwd, interactive: false, notice,
      });
      const opts = loaded as unknown as AcpFlags;
      // Every cwd-relative runtime location is resolved per session, never via process.chdir.
      opts.root = resolve(request.cwd, opts.root);
      if (opts.memory !== undefined) opts.memory = resolve(request.cwd, opts.memory);
      if (opts.mcpConfig !== undefined) opts.mcpConfig = resolve(request.cwd, opts.mcpConfig);
      if (opts.skills !== undefined) opts.skills = opts.skills.map(path => resolve(request.cwd, path));
      const trusted = opts.mcpConfig === undefined ? [] : await readMcpConfig(opts.mcpConfig);
      const matched = matchAcpMcp(request, trusted);
      // Empty client MCP list means no transport-requested servers, not all configured servers.
      if (matched.length === 0) delete opts.mcpConfig;
      validateAbortRestores(opts); const budget = parseBudget(opts);
      const soft = parseSoft(opts.supervisorSoft ?? "0.8");
      const turnsRemaining = parseTurnsRemaining(opts.supervisorTurnsRemaining ?? "15");
      let built: BuiltAgent | undefined;
      const controller: TuiController = new TuiController({ cwd: request.cwd, model: opts.model,
        agent: { run() { throw new Error("agent not ready"); } },
        onSession: (session: Session) => {
          observe(session);
          if (!opts.supervise || built === undefined) return;
          return supervise(session, supervisorOptions({ opts, task: "", budget: budget.budget,
            ...(budget.pricing === undefined ? {} : { pricing: budget.pricing }), memoryIndex: built.memoryIndex,
            provider: built.provider, reviewProvider: built.providers.supervisor, restoreCheckpoint: checkpointRestorer(opts.root),
            onRestore: result => { if (result.restored) controller.forgetRestoredConversation(); }, soft, turnsRemaining,
            onError: notice }));
        } });
      try {
        built = await (dependencies.build ?? buildAgent)(opts, { permissionGrants: controller.permissionGrants,
          onAsk: opts.headless ? async () => "deny" : controller.ask, mcpServers: matched, mcpExistingPinsOnly: true,
          onQuestion: controller.askQuestion,
          onHookError: notice, onHookDone: notice, onNotice: notice });
        if (built.mcp.length !== matched.length) throw new Error("MCP server unavailable or definitions need operator approval");
        controller.attach(built.agent);
      } catch (error) { await controller.shutdown(); await Promise.allSettled((built?.mcp ?? []).map(client => client.close())); throw error; }
      const assembled = built;
      const abort = new AbortController(); let closed = false;
      return { controller,
        async close() { if (closed) return; closed = true; abort.abort(); await controller.shutdown(); await Promise.allSettled(assembled.mcp.map(client => client.close())); },
        ...(assembled.memoryStore === undefined ? {} : { memory: async (query: string) => {
          if (closed) throw new Error("session closed");
          if (await assembled.permissions?.decide({ tool: "memory_search", class: "read", input: { query }, cwd: request.cwd }) !== "allow") throw new Error("memory read denied by configured policy");
          const index = await assembled.memoryStore!.index({ maxFileBytes: 262_144, signal: abort.signal });
          if (!query) return index.slice(0, 32).map(entry => `${entry.path} — ${entry.summary}`);
          const pages = await assembled.memoryStore!.pages({ signal: abort.signal,
            scanLimits: { maxEntries: 512, maxDepth: 8, maxFileBytes: 262_144, maxTotalBytes: 2_097_152 } });
          return unionRetrieve(index, pages, query, 8).map(hit => `${hit.page.path} — ${hit.snippet}`);
        } }),
      };
    } });
  const stop = () => { server.connection.close(); transport.close(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { await Promise.race([transport.closed, server.connection.closed]); stop(); await server.done; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
