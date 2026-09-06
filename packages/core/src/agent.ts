import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Decision, HarnessEvent, PermissionRequest, Usage } from "./events.js";
import { EventPayload, SupervisorRecord } from "./events.js";
import { ContentTrustSchema, type ContentBlock, type ContentTrust, type InstructionContext, type Message } from "./messages.js";
import type { ModelProvider, ModelRequest, StopReason, ToolSpec } from "./provider.js";
import type { PermissionPolicy } from "./permissions.js";
import type { PermissionGrantRegistry } from "./permission-grants.js";
import type { AnyTool } from "./tool.js";
import type { SandboxConfig } from "./sandbox.js";
import { type CompactionStrategy, summarizeOlderTurns, compactWithProvenance } from "./compaction.js";
import { SessionStore, assertSessionId } from "./session-store.js";
import { runHooks, type AttributedHookResult, type Hook, type HookPoint } from "./hooks.js";
import { contextPrincipals, USER_CONTEXT, PLATFORM_CONTEXT, ADVISORY_CONTEXT } from "./context-principals.js";
import { externalExpansion } from "./external-expansion.js";
import { isCheckpointerHook } from "./checkpointer.js";
import { discoverProjectInstructions } from "./project-context.js";
import { evictToolResults, type ToolResultEvictionOptions } from "./tool-result-eviction.js";
import { RepoMapView, type RepoMapOptions } from "./repo-map.js";
import { readOutputTool, READ_OUTPUT_TOOL } from "./tools/read-output.js";
import { createSessionLifecycle, abortGraceOf } from "./session-lifecycle.js";
import { executeTool, createToolEmitterFactory, PLAN_TOOL, type ReplanState } from "./tool-execution.js";
import {
  buildContextManifest,
  renderSystemBlocks,
  type PromptBlock,
} from "./context-manifest.js";

export interface Budget {
  maxTurns?: number;
  maxTokens?: number;
  maxUsd?: number;
  maxMinutes?: number;
}

/** USD per million tokens; required for `budget.maxUsd` to have any effect. */
export interface Pricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Explicit provider/model cache prices override capability multipliers when supplied. */
  cacheReadUsdPerMTok?: number;
  cacheWriteUsdPerMTok?: number;
}

/** All Usage fields are disjoint, so each contributes exactly once to a token budget. */
export function usageTokens(usage: Usage): number {
  return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + usage.output;
}

/**
 * Price one usage record. Cache writes are input tokens at the normal input rate; cache reads use
 * the provider's advertised discount. An unadvertised discount safely falls back to full price.
 */
export function usageUsd(
  usage: Usage,
  pricing: Pricing,
  cacheReadDiscount = 1,
  cacheWriteMultiplier = 1,
): number {
  const readPrice = pricing.cacheReadUsdPerMTok ?? pricing.inputUsdPerMTok * cacheReadDiscount;
  const writePrice = pricing.cacheWriteUsdPerMTok ?? pricing.inputUsdPerMTok * cacheWriteMultiplier;
  return (
    usage.input * pricing.inputUsdPerMTok
    + (usage.cacheRead ?? 0) * readPrice
    + (usage.cacheWrite ?? 0) * writePrice
    + usage.output * pricing.outputUsdPerMTok
  ) / 1e6;
}

export interface PromptContext {
  task: string;
  cwd: string;
}

export interface AgentConfig {
  /** Trusted host opt-in for this run only; unambiguous explicit hook ids, never tool grants. */
  hookInstructionDelegations?: readonly string[];
  provider: ModelProvider;
  tools: AnyTool[];
  permissions: PermissionPolicy;
  /** Optional OS sandbox, applied after permission approval as an independent execution boundary. */
  sandbox?: SandboxConfig;
  /** A string remains supported; labelled blocks produce a source-accurate context manifest. */
  systemPrompt: string | PromptBlock[] | ((ctx: PromptContext) => string | PromptBlock[]);
  /**
   * Canonical project root whose repository-provided instructions may be loaded. Absent means
   * untrusted. Core checks the run cwd itself so another entry point cannot bypass the boundary.
   */
  trustedProjectRoot?: string;
  /** Every event goes through this store; the session log is the source of truth. */
  store: SessionStore;
  budget?: Budget;
  pricing?: Pricing;
  /**
   * Defaults to `summarizeOlderTurns()` (PLAN §2.8). The summarization call goes straight to the
   * provider and is not metered by the budget — its cost is the price of staying under the window.
   */
  compaction?: CompactionStrategy;
  /**
   * Outbound-only structural repository view. Enabled by default; `false` opts out. The generated
   * content is never appended to the immutable session log.
   */
  repoMap?: RepoMapOptions | false;
  /** Outbound-only stale tool-result eviction; enabled with a 5-turn/8-KiB default. */
  toolResultEviction?: ToolResultEvictionOptions;
  /** max_tokens per model response (default 8192). */
  maxTokensPerTurn?: number;
  /**
   * Resolves an `ask` permission decision. Headless default: deny.
   * The TUI (M7) plugs an interactive prompt in here.
   */
  onAsk?: (req: PermissionRequest) => Promise<Exclude<Decision, "ask">>;
  /** Explicit live authority only; event replay never installs grants. Shared with children until R12d. */
  permissionGrants?: PermissionGrantRegistry;
  /**
   * M7: who this session is, when a human answering its permission prompts is not watching it —
   * a subagent sets `"subagent"`. It rides on every `permission.request` this session emits, so
   * the prompt, the log and `sessions show` all agree on who asked.
   */
  origin?: string;
  /** PLAN §2.7. Extension points; a failing or slow hook is reported and skipped, never fatal. */
  hooks?: Hook[];
  hookTimeoutMs?: number;
  /** Wall clock for ALL `session_end` hooks together; they run after the work is done. */
  sessionEndBudgetMs?: number;
  /**
   * After an abort, how long the loop waits for the tool executions the abort orphaned (a running
   * subagent above all) to settle before it writes `session.end` (default 1s). An aborted child
   * finishes its own log in milliseconds (snapshot + `session.end`; its hooks are skipped), so the
   * default is a wide margin for that case while an abort of a tool that ignores its signal still
   * lands promptly. Past the grace the parent ends anyway and records what was still running.
   */
  abortGraceMs?: number;
  now?: () => number;
}

export interface SessionSummary {
  id: string;
  reason: "done" | "aborted" | "error" | "budget";
  turns: number;
  usage: Usage;
  /** Set when the session failed before it could write any event (e.g. resume lock held). */
  error?: string;
}

export interface SessionControl {
  /** Observer lifetime: aborts on user cancellation or when main work enters shutdown.
   * Optional for compatibility with older custom Session implementations. */
  auxiliarySignal?: AbortSignal;
  /** Queued and injected at the next turn boundary. Source defaults to `user`; M4's supervisor passes its own. */
  steer(message: string, source?: "user" | "supervisor" | "hook"): void;
  /** Trusted host control, no model-facing tool. Revokes retained authority on the next request. */
  setHookDelegation?(hookId: string, enabled: boolean): boolean;
  pause(): void;
  resume(): void;
  abort(): void;
  /**
   * Lets the supervisor (PLAN §4.4) write its reasoning into the same log, through the same
   * append chain, so `seq` order stays a single total order. Deliberately narrow: an observer
   * cannot forge a `tool.call` or a `session.end`. Dropped after the session has ended, so
   * `session.end` is always the last line.
   */
  record(payload: SupervisorRecord): void;
  /**
   * PLAN §4.2's `force_replan`: block further tool calls until the agent produces a fresh
   * `plan.updated`. Every tool except `update_plan` is denied with `reason` as the explanation,
   * so the model is told *why* and what to do about it rather than just failing.
   *
   * The gate clears the moment a plan lands — including a plan emitted in the same turn — so a
   * cooperative agent loses one tool call, not a turn. An uncooperative one keeps being denied,
   * which is the point: `force_replan` sits above `inject_guidance` on the ladder precisely
   * because guidance can be ignored and this cannot.
   */
  requirePlan(reason: string): void;
  /** True while a `requirePlan` gate is up. */
  planRequired(): boolean;
  /**
   * Whether this session has a tool that can satisfy a plan gate. A supervisor must not raise a
   * gate a session can never clear — that turns a rung meant to catch a stuck loop into a
   * permanent deadlock, which is strictly worse than the loop.
   */
  canRequirePlan(): boolean;
}

export interface Session {
  id: string;
  events: AsyncIterable<HarnessEvent>;
  control: SessionControl;
  done: Promise<SessionSummary>;
}

export interface RunOptions {
  cwd?: string;
  resume?: string;
  /**
   * A pre-allocated id from `store.create()`, for a caller that must record a session's
   * existence before the session starts writing (the subagent tool logs `subagent.spawn`).
   * Ignored when `resume` is set.
   */
  id?: string;
  /**
   * The session spawning this one, recorded in its `session.start` (#104). The subagent tool sets
   * it; a caller starting a top-level session leaves it unset. Ignored when `resume` is set.
   */
  parent?: string;
}

export interface Agent {
  /**
   * `resume` continues an existing session from its snapshot: same id, same JSONL log
   * (seq continues), prior messages restored, `task` appended as a fresh user message.
   */
  run(task: string, opts?: RunOptions): Session;
}

export { DEFAULT_ABORT_GRACE_MS, abortGraceOf } from "./session-lifecycle.js";

export function toToolSpec(tool: AnyTool): ToolSpec {
  // a tool carrying its own JSON Schema (an MCP tool) advertises that; deriving one from its
  // permissive zod schema would tell the model the input is "an object" and nothing more
  if (tool.jsonSchema !== undefined) {
    return { name: tool.name, description: tool.description, inputSchema: tool.jsonSchema };
  }
  const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, inputSchema: schema };
}

/** Cheap request-size estimate for `model.request.tokensIn`; real usage lands in `model.response`. */
function estimateTokens(system: string, messages: Message[]): number {
  // Instruction context is unified-only metadata, not prompt text billed by the provider.
  const withoutContext = (block: ContentBlock): ContentBlock => {
    const { context: _context, ...rest } = block;
    return rest.type === "tool_result" && Array.isArray(rest.content)
      ? { ...rest, content: rest.content.map(withoutContext) } : rest;
  };
  return Math.ceil((system.length + JSON.stringify(messages.map(message => ({ ...message, content: message.content.map(withoutContext) }))).length) / 4);
}

export { PLAN_TOOL, MAX_REPLAN_REFUSALS } from "./tool-execution.js";

export function createAgent(config: AgentConfig): Agent {
  if (config.sandbox !== undefined && config.sandbox.mode !== "none" && (config.hooks?.length ?? 0) > 0) {
    throw new Error("sandbox modes cannot contain host-process hooks; remove hooks (including ingest/dream-on-end) or explicitly select sandbox none");
  }
  if (config.tools.some((tool) => tool.name === READ_OUTPUT_TOOL)) {
    throw new Error(`${READ_OUTPUT_TOOL} is reserved for immutable session-log output artifacts; remove the custom tool`);
  }
  return { run: (task, opts) => runSession(config, task, opts ?? {}) };
}

function runSession(config: AgentConfig, task: string, opts: RunOptions): Session {
  const { store, provider } = config;
  const now = config.now ?? (() => Date.now());
  // a resumed id is user input (`--resume <id>`) and becomes a filename; reject it here rather
  // than letting it reach the filesystem or a session_end hook that builds a path from it
  const resume = opts.resume === undefined ? undefined : assertSessionId(opts.resume);
  const parent = opts.parent === undefined ? undefined : assertSessionId(opts.parent);
  const taskContext = parent === undefined ? USER_CONTEXT : ADVISORY_CONTEXT;
  const id = resume ?? (opts.id === undefined ? store.create() : assertSessionId(opts.id));
  const grantSessionId = parent === undefined ? id : config.permissionGrants?.context.sessionId;
  // A fresh run owns its log for its lifetime. Two runs appending to one id would restart `seq`
  // and leave a log that cannot be read back at all — which a caller-supplied `id` makes possible
  // for a fresh session, where the resume path's advisory file lock does not apply.
  const releaseClaim = resume === undefined ? store.claim(id) : null;
  let cwd = opts.cwd ?? process.cwd();
  const pendingSteers: Array<{ message: string; source: "user" | "supervisor" | "hook"; context?: InstructionContext }> = [];
  const principals = contextPrincipals(config.hooks ?? []);
  const expansion = externalExpansion();
  if (parent === undefined) expansion.user(task);
  let grantTaskId: string | undefined;
  /** Set by `control.requirePlan`, cleared by the next `plan.updated`. */
  const replan: ReplanState = { reason: null, refusals: 0 };
  const hasPlanTool = config.tools.some((t) => t.name === PLAN_TOOL);

  const lifecycle = createSessionLifecycle(store, id, abortGraceOf(config), (payload) => {
    if (payload.type === "plan.updated") { replan.reason = null; replan.refusals = 0; }
  });
  const { stream, gate, abortController, auxiliaryController, endController, emit, raceAbort, settleOrphans } = lifecycle;
  const flushDelegations = async () => {
    for (const change of principals.drain()) await emit({ type: "context.delegation", ...change });
  };

  const emitFromTool = createToolEmitterFactory(emit, lifecycle.isEnded);

  /**
   * Hook fan-out. Failures are surfaced as non-fatal `error` events so they are visible in the
   * log and to the supervisor, rather than swallowed — a silently skipped hook looks exactly
   * like a hook that decided to do nothing.
   */
  const hook = async (
    point: HookPoint,
    ctx: Omit<Parameters<typeof runHooks>[2], "signal">,
    selectedHooks?: Hook[],
    failClosed = false,
  ): Promise<AttributedHookResult> => {
    const hooks = selectedHooks ?? (config.hooks ?? []).filter((candidate) => !isCheckpointerHook(candidate));
    if (!hooks.some((h) => h.point === point)) return { patches: [], injects: [] };
    const signal = point === "session_end" ? endController.signal : abortController.signal;
    const patchContexts: InstructionContext[] = [];
    const injectContexts: InstructionContext[] = [];
    const result = await runHooks(
      {
        hooks,
        signal,
        onResult: (registered, result) => {
          if (result.action === "modify") patchContexts.push(principals.hook(registered));
          if (result.action === "inject") injectContexts.push(principals.hook(registered));
        },
        // one wall-clock budget for the whole point, so generous per-hook overrides cannot add up
        totalTimeoutMs: point === "session_end" ? (config.sessionEndBudgetMs ?? 15 * 60_000) : 60_000,
        ...(config.hookTimeoutMs === undefined ? {} : { timeoutMs: config.hookTimeoutMs }),
        ...(failClosed ? { failClosed: true } : {}),
        onError: (message) => {
          if (!lifecycle.isEnded()) void emit({ type: "error", message, fatal: false });
        },
      },
      point,
      { ...ctx, signal },
    );
    await flushDelegations();
    return { ...result, patchContexts, injectContexts };
  };

  const done = (async (): Promise<SessionSummary> => {
    const totals: Usage = { input: 0, output: 0 };
    let turns = 0;
    let turnsThisRun = 0;
    let usd = 0;
    let reason: SessionSummary["reason"] = "done";

    const sessionTools = config.tools.length === 0 ? config.tools : [...config.tools, readOutputTool(store)];
    const toolsByName = new Map(sessionTools.map((t) => [t.name, t]));
    const toolSpecs = sessionTools.map(toToolSpec);
    const compaction = config.compaction ?? summarizeOlderTurns();
    const startedAt = now();
    let messages: Message[] = [];
    let system = "";
    let warnedNoUsage = false;
    let compactionExhausted = false;

    // Two concurrent resumes of one id would interleave appends and corrupt the log's seq
    // order, so resume takes an advisory lock. On failure nothing may be appended (the other
    // process owns the log) — the session reports the error through its summary only.
    let releaseLock: (() => Promise<void>) | null = null;
    if (resume !== undefined) {
      try {
        releaseLock = await store.acquireLock(id);
      } catch (err) {
        stream.close();
        const message = err instanceof Error ? err.message : String(err);
        return { id, reason: "error", turns: 0, usage: totals, error: message };
      }
    }

    // A snapshot must always be resumable: a trailing assistant tool_use with no recorded
    // result (max_tokens cut, abort mid-tools) would make both real APIs reject the resumed
    // request, so synthesize error tool_results for whatever went unanswered.
    const resumableMessages = (): Message[] => {
      const last = messages.at(-1);
      if (last === undefined || last.role !== "assistant") return messages;
      const pending = last.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (pending.length === 0) return messages;
      return [
        ...messages,
        {
          role: "user",
          content: pending.map((tu) => ({
            type: "tool_result" as const,
            toolUseId: tu.id,
            content: "[interrupted: the session ended before this tool ran to completion]",
            context: ADVISORY_CONTEXT,
            isError: true,
          })),
        },
      ];
    };

    // best-effort resume cache; the JSONL log stays the source of truth
    const saveSnapshot = async (): Promise<void> => {
      if (messages.length === 0) return;
      try {
        await store.writeSnapshot({
          sessionId: id,
          task,
          cwd,
          turns,
          usage: { ...totals },
          usd,
          messages: resumableMessages(),
          ts: now(),
        });
      } catch {
        // a failed snapshot only makes the next resume impossible, never the session incorrect
      }
    };

    const budgetExceeded = (): string | null => {
      const b = config.budget;
      if (!b) return null;
      if (b.maxTurns !== undefined && turns >= b.maxTurns) return `turn budget reached (${b.maxTurns})`;
      if (b.maxTokens !== undefined && usageTokens(totals) >= b.maxTokens)
        return `token budget reached (${b.maxTokens})`;
      if (b.maxUsd !== undefined && usd >= b.maxUsd) return `USD budget reached ($${b.maxUsd})`;
      if (b.maxMinutes !== undefined && now() - startedAt >= b.maxMinutes * 60_000)
        return `time budget reached (${b.maxMinutes}m)`;
      return null;
    };

    try {
      if (resume !== undefined) {
        // A fork child has no snapshot until its first turn ends; its conversation is the
        // materialized tree (R3c). Anything else without a snapshot is still unresumable.
        const snap = (await store.readSnapshot(id)) ?? (await store.materializeSnapshot(id));
        if (snap === null) throw new Error(`cannot resume session ${id}: no snapshot found`);
        cwd = opts.cwd ?? snap.cwd;
        turns = snap.turns;
        totals.input = snap.usage.input;
        totals.output = snap.usage.output;
        if (snap.usage.cacheRead !== undefined) totals.cacheRead = snap.usage.cacheRead;
        if (snap.usage.cacheWrite !== undefined) totals.cacheWrite = snap.usage.cacheWrite;
        // Price restored token counts under the current complete pricing contract. Old snapshots'
        // `usd` omitted cache activity, and explicit rates may legitimately change between runs.
        usd = config.pricing === undefined
          ? (snap.usd ?? 0)
          : usageUsd(
              totals,
              config.pricing,
              provider.capabilities.cacheReadDiscount,
              provider.capabilities.cacheWriteMultiplier,
            );
        await emit({ type: "session.resume", task, cwd, provider: provider.id, model: provider.model, turns, context: taskContext });
        messages = snap.messages;
        // A written snapshot is already resumable; a materialized one can end at a fork point in
        // the middle of a tool call, and the same synthesis makes it acceptable to the APIs.
        messages = resumableMessages();
        if (task !== "") messages.push({ role: "user", content: [{ type: "text", text: task, context: taskContext }] });
      } else {
        await emit({
          type: "session.start",
          context: taskContext,
          task,
          cwd,
          provider: provider.id,
          model: provider.model,
          ...(parent === undefined ? {} : { parent }),
        });
        messages = [{ role: "user", content: [{ type: "text", text: task, context: taskContext }] }];
      }

      if (parent === undefined) grantTaskId = config.permissionGrants?.beginRun(id);
      await config.permissionGrants?.flush(emit);
      if ((config.hookInstructionDelegations?.length ?? 0) > 128) throw new Error("at most 128 hook instruction delegations per run");
      for (const hookId of config.hookInstructionDelegations ?? []) {
        if (!principals.set(hookId, true)) throw new Error(`unknown or ambiguous hook instruction delegation: ${hookId}`);
      }
      await flushDelegations();

      // user_prompt: a hook may refuse the task outright, rewrite it, or append to it
      {
        const h = await hook("user_prompt", { sessionId: id, cwd, turn: turns, prompt: task });
        if (h.denied !== undefined) {
          await emit({ type: "error", message: `task refused by hook: ${h.denied}`, fatal: true });
          reason = "error";
          return { id, reason, turns, usage: totals };
        }
        for (const bad of h.patches.filter((p) => typeof p !== "string")) {
          await emit({
            type: "error",
            message: `user_prompt patch must be a string (got ${typeof bad}); ignoring`,
            fatal: false,
          });
        }
        // last string wins: two hooks each rewriting the task is a conflict, and the later
        // registration is the more specific one by convention
        const rewrittenIndex = h.patches.map((p, index) => typeof p === "string" ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
        const extra = [...(rewrittenIndex < 0 ? [] : [{ text: h.patches[rewrittenIndex] as string, context: h.patchContexts?.[rewrittenIndex] ?? ADVISORY_CONTEXT }]),
          ...h.injects.map((text, index) => ({ text, context: h.injectContexts?.[index] ?? ADVISORY_CONTEXT }))];
        for (const { text, context } of extra) {
          expansion.unknown();
          const message: Message = { role: "user", content: [{ type: "text", text, context }] };
          messages.push(message);
          await emit({ type: "message.append", message });
        }
      }
      const configuredPrompt = typeof config.systemPrompt === "function" ? config.systemPrompt({ task, cwd }) : config.systemPrompt;
      const systemBlocks: PromptBlock[] = typeof configuredPrompt === "string"
        ? [{
            content: configuredPrompt,
            source: "system_prompt",
            origin: "agent.config.systemPrompt",
            authority: "instruction",
            reason: "base agent instructions",
          }]
        : configuredPrompt.map((block) => ({ ...block }));
      system = renderSystemBlocks(systemBlocks);
      // This gate is deliberately adjacent to the read. A caller-provided boolean would be easy to
      // reuse for another cwd; canonical containment keeps aliases within one trusted project.
      const configuredRoot = config.trustedProjectRoot;
      // A vanished or synthetic cwd is not permission to load anything, but it is not a reason to
      // fail an otherwise valid session either.
      const canonicalRoot = configuredRoot === undefined
        ? undefined
        : await realpath(configuredRoot).catch(() => undefined);
      const canonicalCwd = await realpath(cwd).catch(() => undefined);
      const fromRoot = canonicalRoot === undefined || canonicalCwd === undefined ? ".." : relative(canonicalRoot, canonicalCwd);
      const mayLoadProjectContext = canonicalRoot !== undefined && canonicalCwd !== undefined
        && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
      const projectInstructions = mayLoadProjectContext
        ? await discoverProjectInstructions(canonicalCwd, canonicalRoot)
        : null;
      if (projectInstructions !== null) {
        systemBlocks.push({
          content: `===== BEGIN PROJECT INSTRUCTIONS (${projectInstructions.path}) =====\n${projectInstructions.content}\n===== END PROJECT INSTRUCTIONS =====`,
          source: "project_instructions",
          origin: projectInstructions.path,
          authority: "instruction",
          reason: "nearest trusted project instruction file",
        });
        system = renderSystemBlocks(systemBlocks);
        await emit({
          type: "context.loaded",
          path: projectInstructions.path,
          bytes: projectInstructions.bytes,
        });
      }

      // Like tool-result eviction, the map is a request view: only its compact accounting event is
      // durable. Refreshing checks path/size/mtime each turn and reparses source only after a change.
      // Repository-controlled names and type literals are prompt content too, so the map obeys the
      // same canonical trust boundary as AGENTS.md rather than treating delimiters as authorization.
      const repoMapView = config.repoMap === false || !mayLoadProjectContext || canonicalCwd === undefined
        ? undefined
        : new RepoMapView(canonicalCwd, {
            ...config.repoMap,
            excludePaths: [
              ...(config.repoMap?.excludePaths ?? []),
              config.store.pathFor(id),
              config.store.snapshotPathFor(id),
              config.store.lockPathFor(id),
            ],
          });
      let repoMapContent = "";
      let repoMapFreshness: string | undefined;
      const refreshRepoMap = async (): Promise<void> => {
        if (repoMapView === undefined) return;
        const refreshed = await repoMapView.refresh();
        repoMapContent = refreshed.map.content;
        // This is the marker for the rendered snapshot. Recomputing could race with a filesystem
        // change and claim freshness newer than the map the model actually receives.
        repoMapFreshness = refreshed.map.freshness;
        if (refreshed.regenerated) {
          await emit({
            type: "context.repo_map",
            bytes: refreshed.map.bytes,
            files: refreshed.map.files,
            truncated: refreshed.map.truncated,
            freshness: refreshed.map.freshness,
          });
        }
      };
      await refreshRepoMap();

      loop: while (true) {
        await gate.wait();
        if (abortController.signal.aborted) {
          reason = "aborted";
          break;
        }
        const over = budgetExceeded();
        if (over) {
          reason = "budget";
          await emit({ type: "error", message: over, fatal: false });
          break;
        }

        for (const s of pendingSteers.splice(0)) {
          if (s.source === "user") expansion.user(s.message); else expansion.unknown();
          const context = principals.effective(s.context ?? (s.source === "user" ? USER_CONTEXT
            : { principal: s.source === "supervisor" ? "supervisor" : "hook:anonymous:steer", authority: "advisory" }));
          await emit({ type: "steer", source: s.source, message: s.message, context });
          messages.push({ role: "user", content: [{ type: "text", text: s.message, context }] });
        }

        turns += 1;
        turnsThisRun += 1;
        await emit({ type: "turn.start", n: turns });

        // Eviction and the repository map are outbound views. `messages` remains the complete
        // conversation used by snapshots, resume, hooks and compaction.
        await refreshRepoMap();
        let requestSystemBlocks: PromptBlock[] = systemBlocks;
        if (repoMapContent !== "") {
          requestSystemBlocks = [
            ...systemBlocks,
            {
              content: repoMapContent,
              source: "repo_map",
              origin: canonicalCwd ?? cwd,
              authority: "data",
              reason: "size-budgeted repository orientation snapshot",
              ...(repoMapFreshness === undefined ? {} : { freshness: repoMapFreshness }),
            },
          ];
        }
        const requestSystem = renderSystemBlocks(requestSystemBlocks);
        const eviction = evictToolResults(messages, config.toolResultEviction);
        if (eviction.count > 0) {
          await emit({ type: "context.evicted", count: eviction.count, bytesSaved: eviction.bytesSaved });
        }

        const req: ModelRequest = {
          system: requestSystem,
          messages: eviction.messages,
          tools: toolSpecs,
          maxTokens: config.maxTokensPerTurn ?? 8192,
          cacheHints: { systemPrefix: true, systemPrefixChars: system.length },
        };

        // Assistant content is assembled in stream order so the history replayed to the
        // model matches what it actually said (text and tool_use blocks can interleave).
        const assistantContent: ContentBlock[] = [];
        let text = "";
        let textTrust: ContentTrust | undefined;
        const flushText = () => {
          if (text !== "") {
            assistantContent.push({ type: "text", text, ...(textTrust === undefined ? {} : { trust: textTrust }) });
            text = "";
          }
        };
        {
          // pre_model: last chance to adjust or refuse the request about to be billed
          const h = await hook("pre_model", { sessionId: id, cwd, turn: turns, request: req });
          if (h.denied !== undefined) {
            await emit({ type: "error", message: `model request refused by hook: ${h.denied}`, fatal: false });
            reason = "done";
            break loop;
          }
          for (const [index, patch] of h.patches.entries()) {
            if (patch !== null && typeof patch === "object" && "system" in patch && typeof patch.system === "string") {
              const previous = req.system;
              req.system = patch.system;
              if (previous !== patch.system) expansion.unknown();
              if (patch.system === previous) {
                // Preserve the original bill of materials exactly.
              } else if (patch.system.startsWith(`${previous}\n\n`)) {
                requestSystemBlocks = [
                  ...requestSystemBlocks,
                  {
                    content: patch.system.slice(previous.length + 2),
                    source: "system_prompt",
                    origin: h.patchContexts?.[index]?.principal ?? "hook:anonymous:pre_model",
                    authority: "data",
                    context: h.patchContexts?.[index] ?? ADVISORY_CONTEXT,
                    reason: "pre_model hook appended instructions",
                  },
                ];
              } else {
                // An arbitrary replacement destroys recoverable boundaries; representing the whole
                // rendered value as one hook block is more honest than stale provenance.
                requestSystemBlocks = [{
                  content: patch.system,
                  source: "system_prompt",
                  origin: h.patchContexts?.[index]?.principal ?? "hook:anonymous:pre_model",
                  authority: "data",
                  context: h.patchContexts?.[index] ?? ADVISORY_CONTEXT,
                  reason: "pre_model hook replaced the rendered system prompt",
                }];
              }
            } else {
              // the only shape this point accepts; anything else is a plugin bug and silence
              // would leave its author with no way to find out
              await emit({
                type: "error",
                message: `pre_model patch must be { system: string }; ignoring`,
                fatal: false,
              });
            }
          }
        }

        await flushDelegations();
        expansion.beginRequest();
        req.messages = principals.messages(req.messages);
        requestSystemBlocks = requestSystemBlocks.map(block => {
          const context = principals.effective(block.context ?? (block.authority === "instruction" ? PLATFORM_CONTEXT : ADVISORY_CONTEXT));
          return { ...block, context, authority: context.authority === "instruction" ? "instruction" : "data" };
        });
        req.systemContexts = requestSystemBlocks.filter(block => block.content !== "").map(block => block.context!);
        // Emitted only after the last request mutation and immediately before the provider call.
        // It contains hashes and accounting metadata, never prompt content.
        await emit(buildContextManifest({
          turn: turns,
          request: req,
          systemBlocks: requestSystemBlocks,
          evictedToolUseIds: eviction.evictedToolUseIds,
        }));
        await emit({ type: "model.request", tokensIn: estimateTokens(req.system, req.messages) });

        const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
        let usage: Usage = { input: 0, output: 0 };
        let usageReported = false;
        let usageRetried = false;
        let sawStop = false;
        let stop: StopReason = "end_turn";
        let stopRaw: string | undefined;
        try {
          abortController.signal.throwIfAborted();
          for await (const ev of provider.stream(req, abortController.signal)) {
            switch (ev.type) {
              case "text_delta": {
                const trust = ContentTrustSchema.optional().parse(ev.trust);
                if (trust !== textTrust) flushText();
                textTrust = trust;
                text += ev.text;
                await emit({ type: "model.delta", text: ev.text });
                break;
              }
              case "tool_use": {
                flushText();
                const trust = ContentTrustSchema.optional().parse(ev.trust);
                assistantContent.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input,
                  ...(trust === undefined ? {} : { trust }) });
                toolUses.push(ev);
                break;
              }
              case "usage":
                usage = ev.usage;
                usageReported = ev.reported !== false;
                break;
              case "stop":
                stop = ev.reason;
                sawStop = true;
                stopRaw = ev.raw;
                break;
              case "retry":
                usageRetried = true;
                // informational: the provider re-requested a transient failure; logged so a slow
                // turn is explicable from the session log alone
                await emit({
                  type: "model.retry",
                  attempt: ev.attempt,
                  maxAttempts: ev.maxAttempts,
                  delayMs: ev.delayMs,
                  reason: ev.reason,
                });
                break;
            }
          }
        } catch (err) {
          if (abortController.signal.aborted) {
            reason = "aborted";
            await emit({ type: "turn.end", n: turns });
            break;
          }
          throw err;
        }

        await emit({ type: "model.response", usage, stop,
          usageComplete: usageReported && sawStop && stop !== "error" && !usageRetried });
        {
          // post_model: observe what came back; `inject` queues a follow-up user message
          const h = await hook("post_model", {
            sessionId: id,
            cwd,
            turn: turns,
            response: { role: "assistant", content: textTrust !== undefined || assistantContent.some(block => block.trust !== undefined)
              ? [...assistantContent, ...(text === "" ? [] : [{ type: "text" as const, text,
                ...(textTrust === undefined ? {} : { trust: textTrust }) }])]
              : [{ type: "text", text }] },
          });
          // attributed to `hook`, not `user`: the supervisor's reviewer grades trajectories off
          // these events, and a hook nudge scored as a human correction is a lie in the log
          for (const [index, message] of h.injects.entries()) pendingSteers.push({ message, source: "hook", context: h.injectContexts?.[index] ?? ADVISORY_CONTEXT });
        }
        totals.input += usage.input;
        totals.output += usage.output;
        if (usage.cacheRead !== undefined) totals.cacheRead = (totals.cacheRead ?? 0) + usage.cacheRead;
        if (usage.cacheWrite !== undefined) totals.cacheWrite = (totals.cacheWrite ?? 0) + usage.cacheWrite;
        if (config.pricing) {
          usd += usageUsd(
            usage,
            config.pricing,
            provider.capabilities.cacheReadDiscount,
            provider.capabilities.cacheWriteMultiplier,
          );
        }
        if (usageTokens(usage) === 0 && stop !== "error" && !warnedNoUsage) {
          // e.g. an OpenAI-compatible server ignoring stream_options: budgets can't bind on zeros
          warnedNoUsage = true;
          await emit({
            type: "error",
            message: "provider reported no token usage; token and USD budgets will not bind this session",
            fatal: false,
          });
        }

        flushText();
        if (assistantContent.length > 0) {
          const message: Message = { role: "assistant", content: assistantContent };
          messages.push(message);
          await emit({ type: "message.append", message });
        }

        // A cooperative provider may end its iterator normally on cancellation instead of
        // throwing. Preserve reported usage above, but never classify that cancellation as done.
        if (abortController.signal.aborted) {
          reason = "aborted";
          await emit({ type: "turn.end", n: turns });
          break;
        }
        if (stop === "error") {
          reason = "error";
          await emit({
            type: "error",
            message: `provider reported an error stop${stopRaw === undefined ? "" : ` (stop_reason: ${stopRaw})`}`,
            fatal: true,
          });
          await emit({ type: "turn.end", n: turns });
          break;
        }
        if (stop === "refusal") {
          // the refusal is the model's answer — the session completed, but mark it in the log
          await emit({ type: "error", message: "model refused to continue (stop_reason: refusal)", fatal: false });
          await emit({ type: "turn.end", n: turns });
          break;
        }
        if (stop === "max_tokens") {
          // an answer cut off mid-thought is an incomplete session, not a completed one
          reason = "error";
          await emit({ type: "error", message: `response truncated at maxTokens (${req.maxTokens})`, fatal: false });
          await emit({ type: "turn.end", n: turns });
          break;
        }
        if (toolUses.length === 0) {
          await emit({ type: "turn.end", n: turns });
          break;
        }

        const results: ContentBlock[] = [];
        for (const tu of toolUses) {
          if (abortController.signal.aborted) {
            reason = "aborted";
            await emit({ type: "turn.end", n: turns });
            break loop;
          }
          results.push(await runTool(tu));
        }
        const resultMessage: Message = { role: "user", content: results };
        expansion.input(results);
        messages.push(resultMessage);
        await emit({ type: "message.append", message: resultMessage });

        // Fall back to the estimate when the provider reports no usage, so compaction still
        // fires for servers that never send a usage chunk.
        const contextTokens = usageTokens(usage) || estimateTokens(
          system,
          evictToolResults(messages, config.toolResultEviction).messages,
        );
        if (
          !compactionExhausted &&
          compaction.shouldCompact({ tokens: contextTokens, window: provider.capabilities.contextWindow })
        ) {
          const before = estimateTokens(system, messages);
          // pre_compact: a hook may veto compaction (e.g. to snapshot the full history first).
          // A veto is permanent for the session — re-asking every turn would call the hook on a
          // hot path forever, and a hook that said no once means no.
          const vetoed = await hook("pre_compact", { sessionId: id, cwd, turn: turns, messages });
          if (vetoed.denied !== undefined) {
            await emit({ type: "error", message: `compaction skipped by hook: ${vetoed.denied}`, fatal: false });
            compactionExhausted = true;
          } else try {
            // raced so control.abort() wins over a hung summarization call, same as tools
            const compacted = await raceAbort(compactWithProvenance(compaction, messages, provider, abortController.signal), "compaction");
            const after = estimateTokens(system, compacted);
            const changed = compacted !== messages;
            if (changed) {
              messages = compacted;
              expansion.input(compacted.flatMap(message => message.content));
              await emit({ type: "context.compact", before, after, messages });
            }
            if (changed && after < before * 0.9) {
              // The compacted state and its authoritative replacement event were persisted above.
            } else {
              // no progress possible (tail alone exceeds the window): warn once, stop retrying —
              // a summarization call every turn that can't shrink anything is pure burn
              compactionExhausted = true;
              await emit({
                type: "error",
                message: "compaction could not reduce the context; continuing without it",
                fatal: false,
              });
            }
          } catch (err) {
            if (abortController.signal.aborted) {
              reason = "aborted";
              await emit({ type: "turn.end", n: turns });
              break;
            }
            // a failed optimization must not kill a healthy session
            const message = err instanceof Error ? err.message : String(err);
            await emit({ type: "error", message: `compaction failed: ${message}; continuing uncompacted`, fatal: false });
          }
        }

        await emit({ type: "turn.end", n: turns });
        await saveSnapshot();
      }
    } catch (err) {
      reason = "error";
      const message = err instanceof Error ? err.message : String(err);
      await emit({ type: "error", message, fatal: true }).catch(() => {});
    } finally {
      principals.close();
      await flushDelegations();
      lifecycle.beginEnding();
      // Orphaned work first: a subagent the abort raced past is still finishing its own log, and
      // everything below (snapshot, session_end hooks, session.end) describes a session whose
      // children have ended. Bounded by `abortGraceMs`; no-op when nothing was orphaned.
      await settleOrphans();
      // A resumed run that never completed a turn (lock-free failure, immediate budget stop)
      // must not clobber the previous good snapshot with its own mutations.
      if (resume === undefined || turnsThisRun > 0) await saveSnapshot();
      // a steer that never reached a turn boundary was not delivered — record that, don't lose it
      // session_end: PLAN §3.2/§3.7 both hang off this — memory ingest and the dream trigger.
      // It runs BEFORE `session.end` is written, so a hook can still append to the log; `ended`
      // is not yet set for the same reason. Failures are reported, never fatal: a session that
      // finished its work has finished it, whatever the ingest does afterwards.
      await hook("session_end", {
        sessionId: id,
        cwd,
        turn: turns,
        summary: { id, reason, turns, usage: totals },
      }).catch(() => ({ patches: [], injects: [] }));

      for (const checkpointer of (config.hooks ?? []).filter(isCheckpointerHook)) {
        await checkpointer.seal({
          point:"session_end",sessionId:id,cwd,turn:turns,signal:AbortSignal.any([endController.signal,AbortSignal.timeout(60_000)]),
          hasBackgroundWork:()=>[...toolsByName.values()].some(t=>t.hasBackgroundWork?.()),
          checkpointExcludes:[await realpath(config.store.root)],
          emitCheckpoint:async event=>{await emit(EventPayload.parse(event));},
        }).catch((error:unknown)=>emit({type:"error",message:`checkpoint seal failed: ${String(error)}`,fatal:false}));
        await checkpointer.endSession(id).catch((error: unknown) => emit({
          type: "error", message: `checkpoint lease cleanup failed: ${String(error)}`, fatal: false,
        }));
      }

      for (const s of pendingSteers.splice(0)) {
        await emit({
          type: "error",
          message: `steer from ${s.source} not delivered (session ended): ${s.message}`,
          fatal: false,
        }).catch(() => {});
      }

      try {
        if (grantTaskId !== undefined) config.permissionGrants?.endRun(grantTaskId);
        await config.permissionGrants?.flush(emit);
      } catch (error) {
        reason = "error";
        await emit({ type: "error", message: `permission audit failed: ${String(error)}`, fatal: true }).catch(() => {});
      }
      await lifecycle.finish(reason, releaseLock, releaseClaim);
    }
    return { id, reason, turns, usage: totals };

    function runTool(tu: { id: string; name: string; input: unknown }): Promise<ContentBlock> {
      return executeTool(tu, { config, id, cwd, turns, toolsByName, hasPlanTool, replan, emit,
        expansion,
        ...(grantSessionId === undefined ? {} : { grantSessionId }),
        emitFromTool, hook, signal: abortController.signal, endSignal: endController.signal,
        raceAbort, now, isEnded: lifecycle.isEnded });
    }
  })();

  return {
    id,
    events: stream,
    control: {
      auxiliarySignal: auxiliaryController.signal,
      setHookDelegation: (hookId, enabled) => principals.set(hookId, enabled),
      steer: (message, source = "user") => pendingSteers.push({ message, source }),
      pause: () => gate.pause(),
      resume: () => gate.resume(),
      abort: lifecycle.abort,
      requirePlan: (reason) => {
        replan.reason = reason;
        replan.refusals = 0;
      },
      planRequired: () => replan.reason !== null,
      canRequirePlan: () => hasPlanTool,
      record: (payload) => {
        if (lifecycle.isEnded()) return;
        // validated, not trusted: `Detector` is a public interface, and one third-party detector
        // returning confidence 1.4 or NaN would otherwise write a line the store can never read
        // back. Dropped-and-reported beats a corrupted append-only log.
        const parsed = SupervisorRecord.safeParse(payload);
        if (!parsed.success) {
          void emit({
            type: "error",
            message: `supervisor record rejected: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            fatal: false,
          });
          return;
        }
        void emit(parsed.data);
      },
    },
    done,
  };
}
