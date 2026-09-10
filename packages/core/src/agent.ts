import { realpath } from "node:fs/promises";
import { InputAttachmentsSchema, attachmentReader, clipboardBlock, INPUT_LIMITS, type InputAttachment } from "./input-attachments.js";
import { SpendCapError, assertSpendMeter, hasSpendMeter, type SpendLedger } from "./spend-ledger.js";
import { bindSessionSpend, currentSpend, withSpendRun } from "./spend-runtime.js";
import { compactSession, type CompactOptions, type CompactionSession } from "./manual-compaction.js";
import { resolveAgentProvider } from "./provider-selection-runtime.js";
import type { ProviderSelection, ProviderSelectionInfo } from "./provider-selection.js";
import { AgentRoleToolNames } from "./manifests.js";
import { extensionStartup, flushExtensionFailures, withExtensionRun } from "./extension-runtime.js";
import { isAbsolute, relative, sep } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Decision, HarnessEvent, PermissionRequest, Usage } from "./events.js";
import { EventPayload, SupervisorRecord } from "./events.js";
import { AdvisoryPromptContextSchema, advisoryPromptBlocks, ContentTrustSchema, ThinkingBlockSchema, type ContentBlock, type ContentTrust, type InstructionContext, type Message } from "./messages.js";
import type { ModelProvider, ModelRequest, StopReason, ToolSpec } from "./provider.js";
import type { PermissionPolicy } from "./permissions.js";
import type { PermissionGrantRegistry } from "./permission-grants.js";
import type { AnyTool } from "./tool.js";
import type { SandboxConfig } from "./sandbox.js";
import { type CompactionStrategy, summarizeOlderTurns, compactWithProvenance } from "./compaction.js";
import { SessionStore, assertSessionId } from "./session-store.js";
import { runHooks, type AttributedHookResult, type Hook, type HookPoint } from "./hooks.js";
import { contextPrincipals, USER_CONTEXT, PLATFORM_CONTEXT, ADVISORY_CONTEXT } from "./context-principals.js";
import { externalExpansion, readExpansionRestriction } from "./external-expansion.js";
import { assertOutputContract, type OutputContract } from "./output-schema.js";
import { isCheckpointerHook } from "./checkpointer.js";
import { discoverProjectInstructions } from "./project-context.js";
import { evictToolResults, type ToolResultEvictionOptions } from "./tool-result-eviction.js";
import { RepoMapView, type RepoMapOptions } from "./repo-map.js";
import { readOutputTool, READ_OUTPUT_TOOL } from "./tools/read-output.js";
import { createSessionLifecycle, abortGraceOf } from "./session-lifecycle.js";
import { executeTool, createToolEmitterFactory, PLAN_TOOL, type ReplanState } from "./tool-execution.js";
import { sequential, type TurnStrategy, type TurnToolCall } from "./turn-strategy.js";
import { bindParallelRuntime, executeParallel, type PipelineSchedule } from "./parallel-runtime.js";
import {
  buildContextManifest,
  renderSystemBlocks,
  type PromptBlock,
} from "./context-manifest.js";
import { undeliveredSteerMessage } from "./guidance.js";

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
  /** Trusted host selection, sampled once per run; never supplied by model content or replay. */
  providerSelection?: () => ProviderSelection;
  /** Trusted configured-estimate accounting; providers must be metered at construction. */
  spend?: { ledger: SpendLedger; capMicros?: number };
  /** Optional final-answer constraint, compiled by createOutputContract. Not inherited by children. */
  outputContract?: OutputContract;
  /** Trusted nonblocking observation only; failure never changes the run or event log. */
  observeSession?: (session: Session) => void;
  /** Explicit clarification handler, never a permission grant or implicit supervisor policy. */
  onQuestion?: import("./questions.js").QuestionHandler;
  /** Explicit trusted noninteractive answer policy for unattended runs. Must honor cancellation;
   * human-sourced replies are refused. Never inferred from onQuestion or inherited tool output. */
  onUnattendedQuestion?: import("./questions.js").QuestionHandler;
  /** Current build's extension receipts, not replayed authorization or repeated activation. */
  extensions?: { loaded: import("./extensions.js").ExtensionReceipt[]; failed: import("./extensions.js").FailedExtension[] };
  /** Trusted host opt-in for this run only; unambiguous explicit hook ids, never tool grants. */
  hookInstructionDelegations?: readonly string[];
  provider: ModelProvider;
  tools: AnyTool[];
  /** Trusted SDK scheduling seam; sequential by default. Never selected by model content. */
  turnStrategy?: TurnStrategy;
  permissions: PermissionPolicy;
  /** Trusted host choice, never inferred from tool output or restored from a transcript.
   * Unattended honors policy allows after external input, denies unresolved asks and sandbox
   * escalation, and never invokes human approval/question callbacks. It grants no base authority. */
  approvalMode?: "interactive" | "unattended";
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
  onAsk?: (req: PermissionRequest, context?: import("./permissions.js").PermissionAskContext) => Promise<Exclude<Decision, "ask">>;
  /** Explicit live authority only; built-in children receive filtered, task-sealed views. */
  permissionGrants?: PermissionGrantRegistry;
  /** Trusted host restriction, intersected by local roles; applies even to internal tool dispatch. */
  toolAllowlist?: readonly string[];
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
  /** Explicit host input descriptors, not model-selected tool calls or instruction authority. */
  attachments?: readonly InputAttachment[];
  cwd?: string;
  resume?: string;
  /** Bounded external/advisory data from a trusted transport; never fresh user authority. */
  advisoryContext?: readonly string[];
  /** Trusted host provenance only; scheduled tasks are advisory, never fresh user consent. */
  scheduled?: { entryId: string; minute: number; source?: "heartbeat" };
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
  /** Explicit maintenance fork; never a fresh user turn or automatic conversation adoption. */
  compact?(opts: CompactOptions): Promise<CompactionSession>;
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
  if (config.spend?.capMicros !== undefined) assertSpendMeter(config.provider, config.spend.ledger, config.spend.capMicros);
  if (config.outputContract !== undefined) {
    assertOutputContract(config.outputContract);
    if (config.outputContract.mode === "native" && config.provider.capabilities.nativeOutputSchema !== true)
      throw new Error("Native output requires an explicitly opted-in supported adapter");
  }
  if (config.toolAllowlist !== undefined) config = { ...config,
    toolAllowlist: Object.freeze(AgentRoleToolNames.parse(config.toolAllowlist)) };
  if (config.sandbox !== undefined && config.sandbox.mode !== "none" && (config.hooks?.length ?? 0) > 0) {
    throw new Error("sandbox modes cannot contain host-process hooks; remove hooks (including ingest/dream-on-end) or explicitly select sandbox none");
  }
  if ((config.hooks ?? []).filter(isCheckpointerHook).length > 1) {
    // Two instances do not checkpoint twice: each keeps its OWN leases, owned state and uncertainty
    // set, so the second one's `lease` finds the first one's lock directory and reports "another
    // session or retained lock exists; stop writers before manual recovery" — a diagnostic that
    // sends the operator looking for a stray process instead of at their own hook list.
    throw new Error("only one Checkpointer may be configured; remove the duplicate hook instance");
  }
  if (config.tools.some((tool) => tool.name === READ_OUTPUT_TOOL)) {
    throw new Error(`${READ_OUTPUT_TOOL} is reserved for immutable session-log output artifacts; remove the custom tool`);
  }
  return { compact: opts => compactSession(resolveAgentProvider(config).config, opts), run: (task, opts) => withSpendRun(config.spend?.ledger, () => {
    const selected = resolveAgentProvider(config);
    const session = runSession(selected.config, task, opts ?? {}, selected.selection);
    bindSessionSpend(session);
    try { void Promise.resolve(config.observeSession?.(session)).catch(() => {}); } catch { /* observation is not execution authority */ }
    return session;
  }) };
}

function runSession(config: AgentConfig, task: string, opts: RunOptions, selection?: ProviderSelectionInfo): Session {
  let previousSelection: ProviderSelectionInfo | undefined;
  const attachments = opts.attachments === undefined ? [] : InputAttachmentsSchema.parse(opts.attachments);
  const advisoryContext = opts.advisoryContext === undefined ? undefined : AdvisoryPromptContextSchema.parse(opts.advisoryContext);
  const { store, provider } = config;
  const now = config.now ?? (() => Date.now());
  // a resumed id is user input (`--resume <id>`) and becomes a filename; reject it here rather
  // than letting it reach the filesystem or a session_end hook that builds a path from it
  const resume = opts.resume === undefined ? undefined : assertSessionId(opts.resume);
  const parent = opts.parent === undefined ? undefined : assertSessionId(opts.parent);
  const scheduled = opts.scheduled === undefined ? undefined : { ...opts.scheduled };
  if (scheduled !== undefined && (resume !== undefined || parent !== undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(scheduled.entryId) || !Number.isSafeInteger(scheduled.minute) || scheduled.minute < 0)) throw new Error("invalid scheduled run descriptor");
  const taskContext = parent === undefined && scheduled === undefined ? USER_CONTEXT : ADVISORY_CONTEXT;
  const id = resume ?? (opts.id === undefined ? store.create() : assertSessionId(opts.id));
  const grantSessionId = parent === undefined ? id : config.permissionGrants?.context.sessionId;
  // A fresh run owns its log for its lifetime. Two runs appending to one id would restart `seq`
  // and leave a log that cannot be read back at all — which a caller-supplied `id` makes possible
  // for a fresh session, where the resume path's advisory file lock does not apply.
  const releaseClaim = resume === undefined ? store.claim(id) : null;
  let cwd = opts.cwd ?? process.cwd();
  const pendingSteers: Array<{ message: string; source: "user" | "supervisor" | "hook"; context?: InstructionContext }> = [];
  const principals = contextPrincipals(config.hooks ?? []);
  const expansion = externalExpansion(parent !== undefined && resume === undefined ? readExpansionRestriction(opts) ?? true : true);
  if (parent === undefined && scheduled === undefined) expansion.user(task);
  if (advisoryContext?.length) expansion.unknown();
  let grantTaskId: string | undefined;
  /** Set by `control.requirePlan`, cleared by the next `plan.updated`. */
  const replan: ReplanState = { reason: null, refusals: 0 };
  const questionState: import("./question-runtime.js").QuestionState = {};
  const output = config.outputContract;
  let outputRepair = false, outputValidated = false;
  const hasPlanTool = config.tools.some((t) => t.name === PLAN_TOOL);

  const lifecycle = createSessionLifecycle(store, id, abortGraceOf(config), (payload) => {
    if (payload.type === "plan.updated") { replan.reason = null; replan.refusals = 0; }
  });
  const { stream, gate, abortController, auxiliaryController, endController, emit, raceAbort, settleOrphans } = lifecycle;
  const spend = currentSpend();
  if (spend !== undefined) spend.session = id;
  if (spend !== undefined) spend.onCap = async error => {
    if (!lifecycle.isEnded()) await emit({ type: "budget.cap", reason: error.reason, segment: spend.segment });
  };
  if (spend !== undefined) spend.onUnavailable = async () => {
    if (spend.unavailable) return;
    spend.unavailable = true;
    if (!lifecycle.isEnded()) await emit({ type: "error", message: "spend accounting unavailable; uncapped execution continues with unknown usage coverage", fatal: false });
  };
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
    await flushExtensionFailures();
    return { ...result, patchContexts, injectContexts };
  };

  const done = withExtensionRun({ signal: abortController.signal, emit, isEnded: lifecycle.isEnded }, async (): Promise<SessionSummary> => {
    const totals: Usage = { input: 0, output: 0 };
    let turns = 0;
    let turnsThisRun = 0;
    let usd = 0;
    let reason: SessionSummary["reason"] = "done";

    const availableTools = config.tools.length === 0 && !config.toolAllowlist?.includes("read_output")
      ? config.tools : [...config.tools, readOutputTool(store)];
    const sessionTools = config.toolAllowlist === undefined ? availableTools : availableTools.filter(tool => config.toolAllowlist!.includes(tool.name));
    const toolsByName = new Map(sessionTools.map((t) => [t.name, t]));
    const toolSpecs = sessionTools.map(toToolSpec);
    const compaction = config.compaction ?? summarizeOlderTurns();
    const startedAt = now();
    let messages: Message[] = [];
    let system = "";
    let warnedNoUsage = false;
    let compactionExhausted = false;
    let consecutiveContinuations = 0;
    let continuationFrom: number | undefined;

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
          ...(previousSelection === undefined ? {} : { providerSelection: previousSelection }),
          ts: now(),
        });
      } catch {
        // a failed snapshot only makes the next resume impossible, never the session incorrect
      }
    };

    const budgetExceeded = (completedTurns = turns): string | null => {
      const b = config.budget;
      if (!b) return null;
      if (b.maxTurns !== undefined && completedTurns >= b.maxTurns) return `turn budget reached (${b.maxTurns})`;
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
        await emit({ type: "session.resume", task, cwd, provider: provider.id, model: provider.model, turns, context: taskContext,
          ...(advisoryContext === undefined ? {} : { advisoryContext }) });
        messages = snap.messages;
        previousSelection = snap.providerSelection;
        // A written snapshot is already resumable; a materialized one can end at a fork point in
        // the middle of a tool call, and the same synthesis makes it acceptable to the APIs.
        messages = resumableMessages();
        if (task !== "") messages.push({ role: "user", content: [{ type: "text", text: task, context: taskContext }] });
        if (advisoryContext?.length) messages.push({ role: "user", content: advisoryPromptBlocks(advisoryContext) });
      } else {
        await emit({
          type: "session.start",
          ...(attachments.length ? { inputAttachments: true as const } : {}),
          context: taskContext,
          task,
          ...(advisoryContext === undefined ? {} : { advisoryContext }),
          cwd,
          provider: provider.id,
          model: provider.model,
          ...(parent === undefined ? {} : { parent }),
        });
        if (scheduled !== undefined) await emit({ type: "run.scheduled", entryId: scheduled.entryId, minute: scheduled.minute,
          ...(scheduled.source === undefined ? {} : { source: scheduled.source }) });
        messages = [{ role: "user", content: [{ type: "text", text: task, context: taskContext, ...(scheduled === undefined ? {} : { trust: "project" as const }) }] }];
        if (task === "" && attachments.length) messages = [];
        if (advisoryContext?.length) {
          if (task === "") messages = [];
          messages.push({ role: "user", content: advisoryPromptBlocks(advisoryContext) });
        }
      }

      if (config.spend !== undefined && spend !== undefined && !hasSpendMeter(provider, config.spend.ledger, config.spend.capMicros)) {
        try { await config.spend.ledger.gap(spend.segment, id); }
        catch { await spend.onUnavailable?.(); }
      }
      if (config.spend?.capMicros !== undefined) {
        try { await config.spend.ledger.check(config.spend.capMicros, abortController.signal); }
        catch (error) {
          if (abortController.signal.aborted) throw error;
          const capError = error instanceof SpendCapError ? error : new SpendCapError("unavailable"); await spend?.onCap?.(capError); throw capError;
        }
      }
      for (const extension of config.extensions?.loaded ?? []) {
        const status = extensionStartup(extension);
        await emit({ type: "extension.loaded", name: extension.name, path: extension.path, surfaces: extension.surfaces,
          ...(status.disabled === undefined ? {} : { disabled: true }) });
        if (status.pending !== undefined) await emit({ type: "extension.error", ...status.pending });
      }
      for (const extension of config.extensions?.failed ?? []) await emit({ type: "extension.error", ...extension });
      if (parent === undefined) grantTaskId = config.permissionGrants?.beginRun(id);
      await config.permissionGrants?.flush(emit);
      if ((config.hookInstructionDelegations?.length ?? 0) > 128) throw new Error("at most 128 hook instruction delegations per run");
      for (const hookId of config.hookInstructionDelegations ?? []) {
        if (!principals.set(hookId, true)) throw new Error(`unknown or ambiguous hook instruction delegation: ${hookId}`);
      }
      await flushDelegations();

      if (attachments.length) {
        const blocks: ContentBlock[] = []; let textBytes = 0, imageBytes = 0;
        for (const attachment of attachments) {
          abortController.signal.throwIfAborted();
          let block: ContentBlock | undefined, size = 0;
          if (attachment.kind === "clipboard") {
            if (config.sandbox !== undefined && config.sandbox.mode !== "none") throw new Error("clipboard attachments require a non-enforcing host session");
            block = clipboardBlock(attachment.data); size = Buffer.byteLength(attachment.data,"base64");
          } else {
            const reader = attachmentReader((value, bytes) => { block = value; size = bytes; });
            const result = await executeTool({ id: `input-${blocks.length}`, name: reader.name, input: { path: attachment.path } }, {
              config, id, cwd, turns, toolsByName: new Map([[reader.name,reader]]), hasPlanTool: false, replan: { reason: null, refusals: 0 },
              emit: payload => emit((payload.type === "tool.call" || payload.type === "tool.result" || payload.type === "tool.result.patched")
                ? { ...payload, internal: { kind: "attachment", parentToolUseId: "user-input" } } : payload),
              emitFromTool, hook: async (...args) => {
                const result = await hook(...args);
                if (result.patches.length || result.injects.length) throw new Error("attachment hook rewrites are unsupported; no attachment sent");
                return result;
              },
              expansion, ...(grantSessionId === undefined ? {} : { grantSessionId }),
              signal: abortController.signal, endSignal: endController.signal, raceAbort, now, isEnded: lifecycle.isEnded,
            });
            if (result.type !== "tool_result" || result.isError || block === undefined) throw new Error("file attachment refused; no attachment sent");
            block = { ...block, trust: result.trust ?? "external", context: ADVISORY_CONTEXT };
          }
          if (block.type === "image") imageBytes += size; else textBytes += size;
          if (imageBytes > INPUT_LIMITS.imageTotal || textBytes > INPUT_LIMITS.textTotal) throw new Error("aggregate attachment byte limit exceeded");
          blocks.push({ type: "text", text: attachment.kind === "file" ? `Attached file ${JSON.stringify(attachment.path)}:` : "Explicit clipboard image:",
            trust: block.trust ?? "external", context: ADVISORY_CONTEXT }, block);
        }
        abortController.signal.throwIfAborted();
        const message: Message = { role: "user", content: blocks };
        await emit({ type: "message.append", message }); messages.push(message);
      }

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
        if (output !== undefined) requestSystemBlocks = [...requestSystemBlocks, { content: `Return your final answer as one complete JSON value matching this schema. No Markdown or prose outside JSON. Schema: ${JSON.stringify(output.schema)}`,
          source: "system_prompt", origin: "output-schema", authority: "data", context: ADVISORY_CONTEXT, reason: "operator-selected final output shape, not execution authority" }];
        const requestSystem = renderSystemBlocks(requestSystemBlocks);
        const eviction = evictToolResults(messages, config.toolResultEviction);
        if (eviction.count > 0) {
          await emit({ type: "context.evicted", count: eviction.count, bytesSaved: eviction.bytesSaved });
        }

        const req: ModelRequest = {
          system: requestSystem,
          messages: eviction.messages,
          tools: outputRepair ? [] : toolSpecs,
          ...(output?.mode === "native" ? { outputSchema: output.schema as Record<string, unknown> } : {}),
          maxTokens: config.maxTokensPerTurn ?? 8192,
          cacheHints: { systemPrefix: true, systemPrefixChars: system.length },
        };

        // Assistant content is assembled in stream order so the history replayed to the
        // model matches what it actually said (text and tool_use blocks can interleave).
        const assistantContent: ContentBlock[] = [];
        let thinkingBytes = 0;
        let thinkingCount = 0;
        let text = "";
        let textTrust: ContentTrust | undefined;
        const flushText = () => {
          if (text !== "") {
            assistantContent.push({ type: "text", text, ...(textTrust === undefined ? {} : { trust: textTrust }) });
            text = "";
          }
        };
        {
          // pre_model: last chance to adjust or refuse the request about to be billed.
          //
          // Order, deliberately: observers run against the rendered request, and the authority
          // remap below runs after them. A hook cannot see the labels its own patch will be given,
          // which is what stops "read the manifest, then contribute under the authority you just
          // read". Every contribution is labelled `authority: "data"` with the hook as its origin
          // whatever the hook returns, so the ordering cannot be used for an upgrade either way.
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
                // A patch that is not "the previous text plus a suffix" is an arbitrary rewrite: it
                // may have deleted, reordered or edited text from the project prompt, the skill
                // catalogue and the memory recall alike, and there is no way left to say which
                // surviving byte came from which of them. So the WHOLE rendered prompt is
                // downgraded to one hook-owned `data` block rather than keeping per-source blocks
                // that would now be claims about text this hook may have rewritten. That is a loss
                // of resolution, not of authority: no block gains any, and `expansion.unknown()`
                // above has already marked the turn's expansion surface unknown.
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

        if (hasPlanTool && turnsThisRun === 1) {
          // A resumed conversation that already declared a plan does not need the worked examples
          // and the field-length rules again — it has them in its own history. Every load-bearing
          // clause stays in both: plan substantial work, keep a check per item, checks are
          // declarations rather than proof, and this is not consent. The model decides whether
          // ordinary work needs a plan; the independent supervisor replan gate is unchanged.
          const declaredPlan = messages.some(message => message.role === "assistant"
            && message.content.some(block => block.type === "tool_use" && block.name === PLAN_TOOL));
          const instruction = declaredPlan
            ? "Acceptance planning: this conversation already declared a plan. For continuing multi-step work, call update_plan with the complete revised plan, keeping an accept check on every item. A simple follow-up question does not need a plan update. " +
              "Explicit user/skill planning requirements and supervisor-required replanning still apply. " +
              "These remain declared checks, not verified evidence; marking an item done does not prove its check passed. " +
              "This planning request does not grant permission or represent new user consent."
            : "Acceptance planning: use planning proportional to the task. For a straightforward question or small direct task, answer without update_plan unless planning is explicitly required. " +
              "For multi-step implementation, investigation or risky changes, call update_plan with the complete plan before substantive work. " +
              "Explicit user/skill planning requirements and supervisor-required replanning still apply. " +
              "Include an accept field for every item: a concrete observable check such as 'pnpm test exits 0' or 'the endpoint returns 401 without a token'. " +
              "Keep each check nonblank and at most 1024 characters. These are declared checks, not verified evidence; marking an item done does not prove its check passed. " +
              "This planning request does not grant permission or represent new user consent.";
          req.system = [req.system, instruction].filter(text => text !== "").join("\n\n");
          requestSystemBlocks = [...requestSystemBlocks, { content: instruction, source: "system_prompt",
            origin: "runtime.acceptance-planning", authority: "instruction", context: PLATFORM_CONTEXT,
            reason: declaredPlan ? "first request of a resumed run asks for a revised plan, not proof"
              : "first request asks for observable acceptance declarations, not proof" }];
        }
        await flushDelegations();
        expansion.beginRequest();
        req.messages = principals.messages(req.messages);
        requestSystemBlocks = requestSystemBlocks.map(block => {
          const context = principals.effective(block.context ?? (block.authority === "instruction" ? PLATFORM_CONTEXT : ADVISORY_CONTEXT));
          return { ...block, context, authority: context.authority === "instruction" ? "instruction" : "data" };
        });
        req.systemContexts = requestSystemBlocks.filter(block => block.content !== "").map(block => block.context!);
        // Hooks/context preparation can consume wall time or receive cancellation. The
        // current iteration already owns one turn slot; do not charge it a second time.
        const beforeRequestBudget = budgetExceeded(turns - 1);
        if (abortController.signal.aborted || beforeRequestBudget !== null) {
          reason = abortController.signal.aborted ? "aborted" : "budget";
          if (reason === "budget") await emit({ type: "error", message: beforeRequestBudget!, fatal: false });
          await emit({ type: "turn.end", n: turns });
          break;
        }
        // Emitted only after the last request mutation and immediately before the provider call.
        // It contains hashes and accounting metadata, never prompt content.
        provider.validateHistory?.(req.messages);
        if (selection !== undefined && JSON.stringify(selection) !== JSON.stringify(previousSelection)) {
          await emit({ type: "provider.switched", to: selection, turn: turns,
            ...(previousSelection === undefined ? {} : { from: previousSelection }) });
          previousSelection = selection;
        }
        // Imported receipts are history, not a selection for an unconfigured host.
        if (selection === undefined) previousSelection = undefined;
        await emit(buildContextManifest({
          turn: turns,
          ...(selection === undefined ? {} : { providerSelection: selection }),
          request: req,
          systemBlocks: requestSystemBlocks,
          evictedToolUseIds: eviction.evictedToolUseIds,
        }));
        await emit({ type: "model.request", tokensIn: estimateTokens(req.system, req.messages) });

        const toolUses: TurnToolCall[] = [];
        let usage: Usage = { input: 0, output: 0 };
        let usageReported = false;
        let usageRetried = false;
        let sawStop = false;
        let stop: StopReason = "end_turn";
        let stopRaw: string | undefined;
        try {
          abortController.signal.throwIfAborted();
          // Only an actual provider attempt is a continuation, never a staged retry that a
          // budget, cancellation or pre_model veto prevents. This remains a normal paid turn.
          if (continuationFrom !== undefined) {
            await emit({ type: "turn.continued", n: turns, from: continuationFrom,
              attempt: consecutiveContinuations, maxAttempts: 2, reason: "max_tokens" });
            continuationFrom = undefined;
          }
          for await (const ev of provider.stream(req, abortController.signal)) {
            switch (ev.type) {
              case "thinking": {
                const parsed = ThinkingBlockSchema.safeParse(ev.block);
                if (!parsed.success) throw new Error("invalid reasoning block");
                thinkingBytes += Buffer.byteLength(JSON.stringify(parsed.data));
                if (++thinkingCount > 32 || thinkingBytes > 1_048_576) throw new Error("reasoning response exceeds retention bound");
                flushText();
                // No response prose can supply user provenance or instruction authority.
                assistantContent.push({ ...parsed.data, trust: "generated", context: ADVISORY_CONTEXT });
                break;
              }
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
        // One repair response only. Provider tool calls cannot reach a strategy or any callback,
        // even if the provider ignores the empty advertised registry. Preserve paired history.
          if (outputRepair && (toolUses.length > 0 || stop !== "end_turn" || !sawStop)) {
          if (toolUses.length > 0) {
            const message: Message = { role: "user", content: toolUses.map(tu => ({ type: "tool_result", toolUseId: tu.id,
              isError: true, context: ADVISORY_CONTEXT, content: "[not executed: final-output repair cannot use tools]" })) };
            messages.push(message); await emit({ type: "message.append", message });
          }
          await emit({ type: "output.validated", digest: output!.digest, mode: output!.mode, attempt: "repair", valid: false, category: toolUses.length ? "tool" : "stop" });
          reason = "error"; await emit({ type: "turn.end", n: turns }); break;
        }
        if (stop === "max_tokens") {
          // Even parseable calls from this response are incomplete work, not permission to
          // dispatch. Persist explicit paired non-execution results before any retry/resume.
          if (toolUses.length > 0) {
            const message: Message = { role: "user", content: toolUses.map(tu => ({
              type: "tool_result", toolUseId: tu.id, isError: true, context: ADVISORY_CONTEXT,
              content: "[interrupted: response reached max_tokens; this tool was NOT executed. Request it again if still needed.]",
            })) };
            messages.push(message);
            await emit({ type: "message.append", message });
          }
          if (consecutiveContinuations >= 2) {
            reason = "error";
            await emit({ type: "error", message: `response truncated at maxTokens (${req.maxTokens}); continuation limit exhausted (2)`, fatal: false });
            await emit({ type: "turn.end", n: turns });
            break;
          }
          consecutiveContinuations += 1;
          continuationFrom = turns;
          const message: Message = { role: "user", content: [{ type: "text", context: ADVISORY_CONTEXT,
            text: "[Platform continuation: the previous response reached its output limit. Continue the existing task from the partial response. No tool calls from that truncated response were executed; request any needed calls again. This is not new user input or approval.]" }] };
          messages.push(message);
          await emit({ type: "message.append", message });
        } else {
          consecutiveContinuations = 0;
        }
        if (stop !== "max_tokens" && toolUses.length === 0) {
          if (output !== undefined) {
            const finalText = assistantContent.map(block => block.type === "text" ? block.text : "").join("");
          const category = sawStop && stop === "end_turn" ? output.validate(finalText) : "stop";
            await emit({ type: "output.validated", digest: output.digest, mode: output.mode,
              attempt: outputRepair ? "repair" : "initial", valid: category === "valid", category });
            outputValidated = category === "valid";
            if (!outputValidated && !outputRepair && category !== "stop") {
              outputRepair = true;
              const message: Message = { role: "user", content: [{ type: "text", context: ADVISORY_CONTEXT,
                text: "[Platform output repair: the final answer failed JSON/schema validation. Return one corrected complete JSON value matching the existing schema. Do not call tools. This is not new user input or permission.]" }] };
              messages.push(message); await emit({ type: "message.append", message });
              await emit({ type: "turn.end", n: turns }); continue;
            }
            if (!outputValidated) reason = "error";
          }
          await emit({ type: "turn.end", n: turns });
          break;
        }

        // Truncated model calls never reach any strategy, including trusted custom strategies.
        const { results, interrupted } = stop === "max_tokens" ? { results: [], interrupted: false }
          : await (config.turnStrategy ?? sequential).execute(toolUses,
            bindParallelRuntime({ signal: abortController.signal, runTool }, (calls, limit) =>
              executeParallel(calls, abortController.signal, limit, runTool,
                () => (config.hooks?.length ?? 0) > 0 || [...toolsByName.values()].some(tool => tool.hasBackgroundWork?.() === true))));
        if (interrupted) {
          reason = "aborted";
          await emit({ type: "turn.end", n: turns });
          break loop;
        }
        if (results.length > 0) {
          const resultMessage: Message = { role: "user", content: results };
          expansion.input(results);
          messages.push(resultMessage);
          await emit({ type: "message.append", message: resultMessage });
        }
        if (questionState.failed !== undefined) {
          reason = "error";
          await emit({ type: "error", message: questionState.failed, fatal: true });
          await emit({ type: "turn.end", n: turns });
          break loop;
        }

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
      reason = abortController.signal.aborted ? "aborted" : err instanceof SpendCapError ? "budget" : "error";
      const message = err instanceof Error ? err.message : String(err);
      await emit({ type: "error", message, fatal: true }).catch(() => {});
    } finally {
      if (output !== undefined && !outputValidated && reason === "done") {
        reason = "error";
        await emit({ type: "error", message: "No validated final output was produced", fatal: false }).catch(() => {});
      }
      principals.close();
      await flushDelegations();
      lifecycle.beginEnding();
      // A staged continuation that never became an attempt. The nudge message is already in the
      // log — it is appended before the next turn starts — but `turn.continued` is emitted only
      // for an ACTUAL provider attempt, so a budget stop, an abort or a pre_model veto in between
      // leaves a persisted "[Platform continuation: …]" user message with no attempt beside it.
      // Reading the log, that is indistinguishable from a retry that ran and produced nothing.
      // Saying so costs one non-fatal line and changes no counter: `consecutiveContinuations` is
      // not spent, no attempt is claimed, and nothing here re-enables the retry.
      if (continuationFrom !== undefined) {
        await emit({ type: "error", fatal: false,
          message: `continuation staged after turn ${continuationFrom} was never attempted (${reason}); the persisted continuation message is not a retry`,
        }).catch(() => {});
        continuationFrom = undefined;
      }
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
      // An informational notice must not skip owned cleanup if its append fails.
      await emit({ type: "session.finishing", reason }).catch(() => {});
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
          // Shared with `GuidanceLog`, which reads this back: `/why` must never report guidance
          // that never reached a turn boundary as injected.
          message: undeliveredSteerMessage(s.source, s.message),
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
      await flushExtensionFailures();
      if (spend !== undefined && config.spend !== undefined) {
        try {
          if (spend.unavailable) await config.spend.ledger.gap(spend.segment, id, "accounting-unavailable");
          await config.spend.ledger.end(spend.segment, id);
        } catch {
          const capped = config.spend.capMicros !== undefined;
          if (capped && reason !== "aborted") reason = "error";
          await emit({ type: "error", message: "spend ledger finalization failed; accounting uncertain and no durable completion receipt", fatal: capped }).catch(() => {});
        }
      }
      await lifecycle.finish(reason, releaseLock, releaseClaim);
    }
    return { id, reason, turns, usage: totals };

    function runTool(tu: TurnToolCall, schedule?: PipelineSchedule): Promise<ContentBlock> {
      return executeTool(tu, { config, id, cwd, turns, toolsByName, hasPlanTool, replan, emit, questionState,
        ...(schedule === undefined ? {} : { schedule }),
        expansion,
        ...(grantSessionId === undefined ? {} : { grantSessionId }),
        emitFromTool, hook, signal: abortController.signal, endSignal: endController.signal,
        raceAbort, now, isEnded: lifecycle.isEnded });
    }
  });

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
