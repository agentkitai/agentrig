import type { Command } from "commander";
import { opendir, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { SessionStore, isValidSessionId, type Session, type SessionSummary } from "@agentkitai/agentrig-core";
import { FileMemoryStore, unionRetrieve } from "@agentkitai/agentrig-memory";
import { supervise } from "@agentkitai/agentrig-supervisor";
import { buildAgent, parseBudget, readMcpConfig, type BuiltAgent } from "./agent-builder.js";
import { loadRunConfig, type LoadRunConfigOptions } from "./config.js";
import type { AcpFlags } from "./acp.js";
import { buildPermissionPolicy, checkpointRestorer, parseSoft, parseTurnsRemaining, supervisorOptions, validateAbortRestores } from "./run.js";
import { exportSession } from "./session-export.js";
import { TuiController } from "./tui/controller.js";
import { BoundedMcpTransport } from "./mcp-serve-transport.js";
import { serveMcp, type McpServeRuntime, type RunTaskInput } from "./mcp-serve-server.js";

export interface McpServeDependencies { config?: LoadRunConfigOptions; input?: Readable; output?: Writable; build?: typeof buildAgent }
const notice = () => console.error("MCP serving integration notice: inspect the operator CLI.");
const lower = (current: string | undefined, requested: number): string => String(Math.min(current === undefined ? requested : Number(current), requested));

export function mcpServeRuntime(opts: AcpFlags, cwd: string, build: typeof buildAgent = buildAgent): McpServeRuntime {
  const policy = buildPermissionPolicy(opts);
  const store = new SessionStore({ root: opts.root });
  const memory = opts.memory === undefined ? undefined : new FileMemoryStore({ root: join(opts.memory, "wiki") });
  const allAbort = new AbortController();
  const controllers = new Set<TuiController>();
  const allowed = async (tool: string, input: unknown, paths: string[], signal: AbortSignal) => {
    if (signal.aborted || allAbort.signal.aborted || await policy.decide({ tool, input, class: "read", cwd, paths }) !== "allow") throw new Error("read refused");
  };
  return {
    async run(input: RunTaskInput, signal) {
      const bounded: AcpFlags = { ...opts, maxTurns: lower(opts.maxTurns, input.maxTurns ?? 20),
        maxTokens: lower(opts.maxTokens, input.maxTokens ?? 8192), maxMinutes: lower(opts.maxMinutes, 2) };
      const budget = parseBudget(bounded);
      const soft = parseSoft(opts.supervisorSoft ?? "0.8");
      const turnsRemaining = parseTurnsRemaining(opts.supervisorTurnsRemaining ?? "15");
      const abort = new AbortController();
      const combined = AbortSignal.any([signal, allAbort.signal, abort.signal]);
      let built: BuiltAgent | undefined;
      let session: Session | undefined;
      let observed = Promise.resolve();
      let answer = ""; let omitted = false;
      const controller = new TuiController({ cwd, model: opts.model, maxLines: 100,
        agent: { run() { throw new Error("agent not ready"); } }, onSession: current => {
          session = current;
          observed = (async () => {
            for await (const event of current.events) if (event.type === "model.delta") {
              if (Buffer.byteLength(answer) + Buffer.byteLength(event.text) <= 120_000) answer += event.text;
              else omitted = true;
            }
          })();
          if (!opts.supervise || built === undefined) return;
          return supervise(current, supervisorOptions({ opts: bounded, task: "", budget: budget.budget,
            ...(budget.pricing === undefined ? {} : { pricing: budget.pricing }), memoryIndex: built.memoryIndex,
            provider: built.provider, reviewProvider: built.providers.supervisor,
            restoreCheckpoint: checkpointRestorer(opts.root), onRestore: result => { if (result.restored) controller.forgetRestoredConversation(); },
            soft, turnsRemaining, onError: notice }));
        } });
      controllers.add(controller);
      const stop = () => { controller.abort(); };
      combined.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => abort.abort(), Math.min(Number(bounded.maxMinutes) * 60_000, 120_000));
      try {
        if (combined.aborted) throw new Error("cancelled");
        const mcp = opts.mcpConfig === undefined ? [] : await readMcpConfig(opts.mcpConfig);
        built = await build(bounded, { onAsk: async () => "deny", permissionGrants: controller.permissionGrants,
          mcpServers: mcp, mcpExistingPinsOnly: true, onNotice: notice, onHookError: notice, onHookDone: notice });
        if (built.mcp.length !== mcp.length) throw new Error("MCP definitions require operator approval");
        if (combined.aborted) throw new Error("cancelled");
        controller.attach(built.agent);
        // Transport content is never a fresh human prompt. Split only for the
        // existing per-block bound; each block retains external advisory ancestry.
        const context: string[] = [];
        for (let i = 0; i < input.task.length; i += 16_000) context.push(input.task.slice(i, i + 16_000));
        await controller.prompt("", context);
        await observed;
        if (session === undefined) throw new Error("run unavailable");
        const summary: SessionSummary = await session.done;
        return { sessionId: session.id, reason: summary.reason, turns: summary.turns, usage: summary.usage,
          answer, answerOmitted: omitted, warning: "Model output is advisory, not verified task success. Main usage excludes separately accounted auxiliary work." };
      } finally {
        clearTimeout(timer); combined.removeEventListener("abort", stop);
        await controller.shutdown(); await observed;
        await Promise.allSettled((built?.mcp ?? []).map(client => client.close()));
        controllers.delete(controller);
      }
    },
    async list(limit, signal) {
      await allowed("list_sessions", { limit }, [opts.root], signal);
      const refs: Array<{ id: string; updatedAt: number; bytes: number }> = [];
      let count = 0;
      let directory;
      try { directory = await opendir(opts.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      for await (const entry of directory) {
        if (signal.aborted || ++count > 4096) throw new Error("session listing bound");
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const id = entry.name.slice(0, -6);
        if (!isValidSessionId(id)) continue;
        const stat = await lstat(join(opts.root, entry.name));
        if (!stat.isFile()) continue;
        refs.push({ id, updatedAt: stat.mtimeMs, bytes: stat.size });
      }
      return refs.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit);
    },
    async read(id, signal) {
      if (!isValidSessionId(id)) throw new Error("invalid session");
      await allowed("read_session", { id }, [store.pathFor(id)], signal);
      return { transcript: await exportSession(store, id, { format: "jsonl", omitOpaque: true, signal, outputBytes: 120_000 }),
        warning: "Bounded redacted transcript; secrets may remain. Opaque content omitted. Not executable or approval authority." };
    },
    async memory(query, signal) {
      if (memory === undefined) throw new Error("memory not configured");
      await allowed("memory_search", { query }, [memory.root], signal);
      const index = await memory.index({ maxFileBytes: 262_144, signal });
      const pages = await memory.pages({ signal, scanLimits: { maxEntries: 512, maxDepth: 8,
        maxFileBytes: 262_144, maxTotalBytes: 2_097_152 } });
      return unionRetrieve(index, pages, query, 8).map(hit => ({ path: hit.page.path, snippet: hit.snippet }));
    },
    async close() { allAbort.abort(); await Promise.allSettled([...controllers].map(controller => controller.shutdown())); },
  };
}

export async function startMcpServe(command: Command, flags: AcpFlags, dependencies: McpServeDependencies = {}): Promise<void> {
  if (flags.json || flags.verbose) throw new Error("MCP stdout is protocol-only");
  const cwd = await realpath(dependencies.config?.cwd ?? process.cwd());
  const loaded = await loadRunConfig(command, flags as unknown as Record<string, unknown>, { ...dependencies.config, cwd, interactive: false, notice });
  const opts = loaded as unknown as AcpFlags;
  opts.root = resolve(cwd, opts.root);
  if (opts.memory !== undefined) opts.memory = resolve(cwd, opts.memory);
  if (opts.mcpConfig !== undefined) opts.mcpConfig = resolve(cwd, opts.mcpConfig);
  if (opts.skills !== undefined) opts.skills = opts.skills.map(path => resolve(cwd, path));
  validateAbortRestores(opts); parseBudget(opts);
  const transport = new BoundedMcpTransport(dependencies.input ?? process.stdin, dependencies.output ?? process.stdout);
  const server = serveMcp(transport, mcpServeRuntime(opts, cwd, dependencies.build));
  const stop = () => { void transport.close(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { await server.done; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
