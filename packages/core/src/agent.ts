import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Decision, HarnessEvent, PermissionRequest, Usage } from "./events.js";
import { EventPayload, SupervisorRecord, TOOL_EMITTABLE_EVENTS, TOOL_EMIT_SOURCES } from "./events.js";
import type { ContentBlock, Message } from "./messages.js";
import type { ModelProvider, ModelRequest, StopReason, ToolSpec } from "./provider.js";
import type { PermissionPolicy } from "./permissions.js";
import type { AnyTool, ToolContext } from "./tool.js";
import { SandboxDeniedError, type SandboxConfig } from "./sandbox.js";
import { type CompactionStrategy, summarizeOlderTurns } from "./compaction.js";
import { SessionStore, assertSessionId, contentHash } from "./session-store.js";
import { mergePatches, runHooks, type Hook, type HookPoint } from "./hooks.js";
import { discoverProjectInstructions } from "./project-context.js";
import { evictToolResults, type ToolResultEvictionOptions } from "./tool-result-eviction.js";
import { RepoMapView, type RepoMapOptions } from "./repo-map.js";
import { outputArtifactMarker, readOutputTool, READ_OUTPUT_TOOL } from "./tools/read-output.js";
import { bound, DISPLAY_CAP, safeSliceEnd } from "./tools/shared.js";
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
  /** Queued and injected at the next turn boundary. Source defaults to `user`; M4's supervisor passes its own. */
  steer(message: string, source?: "user" | "supervisor" | "hook"): void;
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

export const DEFAULT_ABORT_GRACE_MS = 1_000;

/**
 * The abort grace a config asks for: finite and non-negative, else the default (#96). One
 * definition, used by the loop and by the subagent tool when it derives a child's grace, so the
 * two cannot drift apart.
 */
export function abortGraceOf(config: { abortGraceMs?: number | undefined }): number {
  const ms = config.abortGraceMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_ABORT_GRACE_MS;
}

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
  return Math.ceil((system.length + JSON.stringify(messages).length) / 4);
}

/** Buffers every event so late subscribers replay the whole session; supports many readers. */
class EventStream {
  private readonly buffer: HarnessEvent[] = [];
  private closed = false;
  private waiters: Array<() => void> = [];

  push(e: HarnessEvent): void {
    this.buffer.push(e);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
    let i = 0;
    while (true) {
      if (i < this.buffer.length) {
        yield this.buffer[i++]!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

class PauseGate {
  private gate = Promise.resolve();
  private release: (() => void) | null = null;

  pause(): void {
    if (this.release) return;
    this.gate = new Promise<void>((r) => (this.release = r));
  }

  resume(): void {
    this.release?.();
    this.release = null;
  }

  wait(): Promise<void> {
    return this.gate;
  }
}

/** The tool that satisfies a replan gate. Named once so core and the gate cannot drift apart. */
export const PLAN_TOOL = "update_plan";

/**
 * Refusals before a replan gate releases itself. Small on purpose: the gate exists to interrupt,
 * not to stop. If two refusals have not produced a plan, a third will not either.
 */
export const MAX_REPLAN_REFUSALS = 2;

interface OverflowResult {
  display: string;
  output?: string;
  /** Complete-output cursor corresponding to a prefix preview; absent for headers/summaries. */
  prefixLimit?: number;
}

/** Bound every tool, and turn both explicit and forgotten representational overflow into artifacts. */
function overflowResult(result: {
  display: string;
  output: unknown;
  truncated?: boolean;
  fullDisplay?: string;
  displayPrefixChars?: number;
}): OverflowResult {
  const explicit = result.truncated === true && result.fullDisplay !== undefined && result.fullDisplay.length > 0
    ? result.fullDisplay
    : undefined;
  if (explicit !== undefined && explicit !== result.display) {
    const prefixLimit = Number.isSafeInteger(result.displayPrefixChars) && result.displayPrefixChars! >= 0 &&
      result.displayPrefixChars! < explicit.length
      ? result.displayPrefixChars
      : undefined;
    return {
      display: bound(result.display).display,
      output: explicit,
      ...(prefixLimit === undefined ? {} : { prefixLimit }),
    };
  }
  const bounded = bound(result.display);
  return bounded.truncated
    ? { display: bounded.display, output: result.display, prefixLimit: bounded.shown }
    : { display: bounded.display };
}

/** Keep a directly pageable artifact handle inside a caller-selected model-facing display bound. */
function displayWithOutputHandle(
  display: string,
  output: string,
  seq: number,
  prefixLimit: number | undefined,
  cap = DISPLAY_CAP,
): string {
  const preview = prefixLimit === undefined ? display : output;
  let visible = Math.min(prefixLimit ?? preview.length, cap);
  let marker = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cursor = prefixLimit === undefined ? 0 : visible;
    const nextTo = safeSliceEnd(output, Math.min(output.length, cursor + DISPLAY_CAP));
    marker = outputArtifactMarker(seq, cursor, nextTo, output.length);
    const nextVisible = safeSliceEnd(
      preview,
      Math.min(prefixLimit ?? preview.length, Math.max(0, cap - marker.length)),
    );
    if (nextVisible === visible) break;
    visible = nextVisible;
  }
  const cursor = prefixLimit === undefined ? 0 : visible;
  const nextTo = safeSliceEnd(output, Math.min(output.length, cursor + DISPLAY_CAP));
  marker = outputArtifactMarker(seq, cursor, nextTo, output.length);
  return `${preview.slice(0, visible)}${marker}`;
}

export function createAgent(config: AgentConfig): Agent {
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
  const id = resume ?? (opts.id === undefined ? store.create() : assertSessionId(opts.id));
  // A fresh run owns its log for its lifetime. Two runs appending to one id would restart `seq`
  // and leave a log that cannot be read back at all — which a caller-supplied `id` makes possible
  // for a fresh session, where the resume path's advisory file lock does not apply.
  const releaseClaim = resume === undefined ? store.claim(id) : null;
  let cwd = opts.cwd ?? process.cwd();
  const stream = new EventStream();
  const gate = new PauseGate();
  const abortController = new AbortController();
  /**
   * `session_end` hooks run under this signal, not the session's (#88). The session's signal is
   * aborted by definition on an aborted session, and `runHooks` skips a point whose signal is
   * already aborted — so no `session_end` hook ever ran for an abort, and the ingest and dream
   * trigger that hang off that point never saw a session that was cut off, which is exactly the
   * kind a memory wants. The abort reason still reaches hooks in `summary.reason`. A SECOND abort,
   * once the session is ending, aborts this one too: the hooks are bounded by their budget, but
   * a person pressing ctrl-C twice means "stop waiting", not "run ingest for fifteen minutes".
   */
  const endController = new AbortController();
  let ending = false;
  const pendingSteers: Array<{ message: string; source: "user" | "supervisor" | "hook" }> = [];
  /** Set by `control.requirePlan`, cleared by the next `plan.updated`. */
  let replanReason: string | null = null;
  /** Refusals under the current gate, so a gate can never be permanent. */
  let replanRefusals = 0;
  const hasPlanTool = config.tools.some((t) => t.name === PLAN_TOOL);

  // All appends go through one promise chain so events written by tools (via ctx.emit)
  // and by the loop land in the store — and in `seq` — in the order they were emitted.
  let chain: Promise<unknown> = Promise.resolve();
  let ended = false;
  const emit = (payload: EventPayload): Promise<HarnessEvent> => {
    // A plan landing satisfies the force_replan gate. Every path to this clearing is authorised:
    // the loop's own emits, or `update_plan` through emitFromTool — whose SOURCE axis drops a
    // `plan.updated` from any other tool before it reaches here (issue #67).
    if (payload.type === "plan.updated") {
      replanReason = null;
      replanRefusals = 0;
    }
    const p = chain.then(() => store.append(id, payload)).then((e) => {
      stream.push(e);
      return e;
    });
    chain = p.catch(() => {});
    return p;
  };

  // A tool the abort race orphaned may still emit after session.end; those events are dropped
  // so the log's last event is always session.end.
  // A factory rather than one shared closure: the loop binds the executing tool's registered name
  // (never a name the payload claims), so the gate can hold tools to the events that are theirs.
  const emitFromTool = (toolName: string) => (payload: EventPayload): void => {
    if (ended) return;
    // A tool's emit is untrusted input, so it is gated on THREE axes, mirroring record():
    //  1. TYPE — a tool may emit only the informational/state kinds tools legitimately produce
    //     (TOOL_EMITTABLE_EVENTS). A forged permission.decision, session.end, or supervisor
    //     record is not one of them.
    //  2. SOURCE — an emittable type that carries authority is held to its one legitimate emitter
    //     (TOOL_EMIT_SOURCES): `plan.updated` releases the force_replan gate below and rewrites the
    //     scope the drift detector enforces, `subagent.*` asserts a child session exists. Any tool
    //     could otherwise emit one `plan.updated` and shrug off the intervention PLAN §4.2 promises
    //     cannot be ignored (issue #67).
    //  3. SHAPE — even an allowed type must be a well-formed EventPayload. The store appends with a
    //     bare JSON.stringify and `read` re-parses with HarnessEvent.parse, which THROWS on a bad
    //     line; raw/ is immutable, so one malformed `{type:"file.changed"}` would permanently break
    //     `sessions show`, resume, and ingest for the session (the same corruption record() guards).
    // Any failure is dropped and reported, never appended — the log stays readable and faithful
    // whatever a tool (a buggy one, or one forwarding hostile content) tries to write.
    const reject = (why: string): void => {
      const type = typeof (payload as { type?: unknown })?.type === "string" ? (payload as { type: string }).type : "unknown";
      void emit({ type: "error", message: `the "${toolName}" tool tried to emit a "${type}" event, ${why}; dropped`, fatal: false });
    };
    if (!TOOL_EMITTABLE_EVENTS.has(payload.type)) return reject("which tools may not emit");
    const soleEmitter = TOOL_EMIT_SOURCES.get(payload.type);
    if (soleEmitter !== undefined && soleEmitter !== toolName) {
      return reject(`which only the "${soleEmitter}" tool may emit`);
    }
    const parsed = EventPayload.safeParse(payload);
    if (!parsed.success) return reject("which is malformed and would corrupt the log");
    void emit(parsed.data);
  };

  /**
   * Hook fan-out. Failures are surfaced as non-fatal `error` events so they are visible in the
   * log and to the supervisor, rather than swallowed — a silently skipped hook looks exactly
   * like a hook that decided to do nothing.
   */
  const hook = async (
    point: HookPoint,
    ctx: Omit<Parameters<typeof runHooks>[2], "signal">,
  ): Promise<{ denied?: string; patches: unknown[]; injects: string[] }> => {
    const hooks = config.hooks ?? [];
    if (!hooks.some((h) => h.point === point)) return { patches: [], injects: [] };
    const signal = point === "session_end" ? endController.signal : abortController.signal;
    return runHooks(
      {
        hooks,
        signal,
        // one wall-clock budget for the whole point, so generous per-hook overrides cannot add up
        totalTimeoutMs: point === "session_end" ? (config.sessionEndBudgetMs ?? 15 * 60_000) : 60_000,
        ...(config.hookTimeoutMs === undefined ? {} : { timeoutMs: config.hookTimeoutMs }),
        onError: (message) => {
          if (!ended) void emit({ type: "error", message, fatal: false });
        },
      },
      point,
      { ...ctx, signal },
    );
  };

  /**
   * Work an abort raced past and left running. The loop must not report itself ended while a
   * subagent it started is still writing its own log: a parent summary that resolves before the
   * child's `session.end` lands made "aborting a session leaves no running children" true only
   * in wall time, and a reader of the child's log (the abort test, `sessions show`) saw a session
   * with no end. Settled entries remove themselves.
   */
  const orphans = new Map<Promise<unknown>, string>();
  const orphan = (work: Promise<unknown>, label: string): void => {
    orphans.set(work, label);
    work.then(() => orphans.delete(work), () => orphans.delete(work));
  };
  // A negative, NaN, or non-finite grace is a configuration mistake, not a request for a
  // never-ending wait: fall back to the default rather than hand setTimeout nonsense.
  const graceMs = abortGraceOf(config);
  const settleOrphans = async (): Promise<void> => {
    if (orphans.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // NOT unref'd: this timer may be the only handle keeping the process alive while a tool that
    // ignores its signal blocks on nothing. Unref'd, Node exited mid-grace with no snapshot and no
    // session.end written — a worse outcome than the wait, and one no in-process test can see.
    const expired = new Promise<"expired">((res) => {
      timer = setTimeout(() => res("expired"), graceMs);
    });
    const outcome = await Promise.race([Promise.allSettled([...orphans.keys()]).then(() => "settled" as const), expired]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "expired") {
      const labels = [...orphans.values()].join(", ");
      await emit({
        type: "error",
        message: `orphaned work still running ${graceMs}ms after abort (${labels}); session.end written without waiting for it`,
        fatal: false,
      }).catch(() => {});
    }
  };

  /** Lets `control.abort()` win over a tool that ignores its signal. */
  const raceAbort = <T>(work: Promise<T>, label: string): Promise<T> => {
    const signal = abortController.signal;
    if (signal.aborted) {
      work.catch(() => {});
      orphan(work, label);
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return new Promise<T>((res, rej) => {
      const onAbort = () => {
        orphan(work, label);
        rej(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(res, rej).finally(() => signal.removeEventListener("abort", onAbort));
      work.catch(() => {});
    });
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
        await emit({ type: "session.resume", task, cwd, provider: provider.id, model: provider.model, turns });
        messages = snap.messages;
        // A written snapshot is already resumable; a materialized one can end at a fork point in
        // the middle of a tool call, and the same synthesis makes it acceptable to the APIs.
        messages = resumableMessages();
        if (task !== "") messages.push({ role: "user", content: [{ type: "text", text: task }] });
      } else {
        await emit({
          type: "session.start",
          task,
          cwd,
          provider: provider.id,
          model: provider.model,
          ...(parent === undefined ? {} : { parent }),
        });
        messages = [{ role: "user", content: [{ type: "text", text: task }] }];
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
        const rewritten = h.patches.filter((p): p is string => typeof p === "string").at(-1);
        const extra = [...(rewritten === undefined ? [] : [rewritten]), ...h.injects];
        for (const text of extra) {
          const message: Message = { role: "user", content: [{ type: "text", text }] };
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
          await emit({ type: "steer", source: s.source, message: s.message });
          messages.push({ role: "user", content: [{ type: "text", text: s.message }] });
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
        const flushText = () => {
          if (text !== "") {
            assistantContent.push({ type: "text", text });
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
          for (const patch of h.patches) {
            if (patch !== null && typeof patch === "object" && "system" in patch && typeof patch.system === "string") {
              const previous = req.system;
              req.system = patch.system;
              if (patch.system === previous) {
                // Preserve the original bill of materials exactly.
              } else if (patch.system.startsWith(`${previous}\n\n`)) {
                requestSystemBlocks = [
                  ...requestSystemBlocks,
                  {
                    content: patch.system.slice(previous.length + 2),
                    source: "system_prompt",
                    origin: "hook:pre_model",
                    authority: "instruction",
                    reason: "pre_model hook appended instructions",
                  },
                ];
              } else {
                // An arbitrary replacement destroys recoverable boundaries; representing the whole
                // rendered value as one hook block is more honest than stale provenance.
                requestSystemBlocks = [{
                  content: patch.system,
                  source: "system_prompt",
                  origin: "hook:pre_model",
                  authority: "instruction",
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
        let stop: StopReason = "end_turn";
        let stopRaw: string | undefined;
        try {
          for await (const ev of provider.stream(req, abortController.signal)) {
            switch (ev.type) {
              case "text_delta":
                text += ev.text;
                await emit({ type: "model.delta", text: ev.text });
                break;
              case "tool_use":
                flushText();
                assistantContent.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
                toolUses.push(ev);
                break;
              case "usage":
                usage = ev.usage;
                break;
              case "stop":
                stop = ev.reason;
                stopRaw = ev.raw;
                break;
              case "retry":
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

        await emit({ type: "model.response", usage, stop });
        {
          // post_model: observe what came back; `inject` queues a follow-up user message
          const h = await hook("post_model", {
            sessionId: id,
            cwd,
            turn: turns,
            response: { role: "assistant", content: [{ type: "text", text }] },
          });
          // attributed to `hook`, not `user`: the supervisor's reviewer grades trajectories off
          // these events, and a hook nudge scored as a human correction is a lie in the log
          for (const message of h.injects) pendingSteers.push({ message, source: "hook" });
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
            const compacted = await raceAbort(compaction.compact(messages, provider, abortController.signal), "compaction");
            const after = estimateTokens(system, compacted);
            const changed = compacted !== messages;
            if (changed) {
              messages = compacted;
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
      ending = true;
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

      for (const s of pendingSteers.splice(0)) {
        await emit({
          type: "error",
          message: `steer from ${s.source} not delivered (session ended): ${s.message}`,
          fatal: false,
        }).catch(() => {});
      }

      ended = true;
      await emit({ type: "session.end", reason }).catch(() => {});
      await chain.catch(() => {});
      await releaseLock?.().catch(() => {});
      releaseClaim?.();
      // Resource cleanup, deliberately LAST (session_end hooks above run under this signal): a
      // settled session's signal aborts so anything tied to it — background jobs above all —
      // dies with the session instead of only on an explicit user abort. A session that ends
      // "done" leaving an invisible watcher burning CPU is the same leak as an aborted one.
      abortController.abort();
      stream.close();
    }
    return { id, reason, turns, usage: totals };

    async function runTool(tu: { id: string; name: string; input: unknown }): Promise<ContentBlock> {
      const resultBlock = (content: string, isError: boolean): ContentBlock =>
        isError
          ? { type: "tool_result", toolUseId: tu.id, content, isError: true }
          : { type: "tool_result", toolUseId: tu.id, content };

      const tool = toolsByName.get(tu.name);
      if (!tool) {
        await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
        await emit({ type: "tool.result", id: tu.id, ok: false, display: `unknown tool: ${tu.name}`, durationMs: 0 });
        return resultBlock(`unknown tool: ${tu.name}`, true);
      }

      // The replan gate: everything except planning is refused while it is up — but it is
      // self-limiting. A gate that could never be released (no `update_plan` in the tool list,
      // an agent that will not call it, permissions that deny it) would burn the whole budget on
      // refusals, which is a worse failure than whatever the supervisor was trying to catch. So
      // it opens itself after MAX_REPLAN_REFUSALS and says why.
      if (replanReason !== null && tu.name !== PLAN_TOOL) {
        replanRefusals += 1;
        if (replanRefusals > MAX_REPLAN_REFUSALS || !hasPlanTool) {
          const why = hasPlanTool
            ? `after ${replanRefusals - 1} refusals`
            : `this session has no ${PLAN_TOOL} tool, so the gate could never be satisfied`;
          await emit({
            type: "error",
            message: `replan gate released ${why}; continuing without a fresh plan`,
            fatal: false,
          });
          replanReason = null;
          replanRefusals = 0;
        } else {
          const display =
            `blocked: the supervisor requires a fresh plan before more tool calls (${replanReason}). ` +
            `Call ${PLAN_TOOL} with your revised plan, then continue.`;
          await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
          await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: 0 });
          return resultBlock(display, true);
        }
      }

      const parsed = tool.inputSchema.safeParse(tu.input);
      if (!parsed.success) {
        const display = `invalid input for ${tu.name}: ${parsed.error.message}`;
        await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
        await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: 0 });
        return resultBlock(display, true);
      }
      // pre_tool: sees the PARSED input, so a hook reasons about typed data rather than raw JSON.
      // A `modify` patch is re-validated against the tool's own schema below — a hook is
      // third-party code, so its patch is a proposal, not an instruction.
      let input = parsed.data;
      {
        const h = await hook("pre_tool", {
          sessionId: id,
          cwd,
          turn: turns,
          tool: { name: tu.name, input },
        });
        if (h.denied !== undefined) {
          // no `tool.call` — matching the permission-deny path exactly. A phantom call for
          // something that never ran feeds the stall detector's productivity count and the loop
          // detector's inputHash tally, so the two deny paths must look the same downstream.
          await emit({ type: "tool.denied", id: tu.id, name: tu.name });
          return resultBlock(`blocked by hook: ${h.denied}`, true);
        }
        if (h.patches.length > 0) {
          const merged = tool.inputSchema.safeParse(mergePatches(input, h.patches));
          if (merged.success) input = merged.data;
          else {
            await emit({
              type: "error",
              message: `hook patch for ${tu.name} did not match its schema; using the original input`,
              fatal: false,
            });
          }
        }
      }

      const permClass = typeof tool.permission === "function" ? tool.permission(input) : tool.permission;
      const declaredPaths = tool.paths?.(input);
      const permReq: PermissionRequest = {
        tool: tu.name,
        input,
        class: permClass,
        cwd,
        ...(declaredPaths === undefined ? {} : { paths: declaredPaths }),
        // whose session this is, when it is not the one a human is watching. Set on the config by
        // whoever built the session (the subagent tool's `childConfig`), never by a tool or by
        // the model — an ask that can name its own origin can lie about it.
        ...(config.origin === undefined ? {} : { origin: config.origin }),
      };
      await emit({ type: "permission.request", req: permReq });
      let decision = await config.permissions.decide(permReq);
      await emit({ type: "permission.decision", d: decision });
      if (decision === "ask") {
        decision = config.onAsk ? await config.onAsk(permReq) : "deny";
        await emit({ type: "permission.decision", d: decision });
      }
      if (decision === "deny") {
        await emit({ type: "tool.denied", id: tu.id, name: tu.name });
        return resultBlock(`permission denied: ${tu.name} [${permClass}]`, true);
      }

      await emit({ type: "tool.call", id: tu.id, name: tu.name, input, inputHash: contentHash(input) });
      const ctx: ToolContext = {
        cwd,
        sessionId: id,
        // bound to the REGISTERED tool's name (the one resolved from toolsByName), which is also
        // what tool.call recorded — not anything the tool or model could claim later
        emit: emitFromTool(tool.name),
        signal: abortController.signal,
        endSignal: endController.signal,
      };
      const t0 = now();
      let sandboxDenialRecorded = false;
      let sandboxRetryDenied = false;
      try {
        const command = () => tool.execute(input, ctx);
        // Approval and sandboxing are independent axes: only an approved call reaches the sandbox,
        // and selecting `none` still traverses the provider seam so providers own mode semantics.
        const prepared = config.sandbox === undefined
          ? command
          : config.sandbox.provider.prepare(command, {
              mode: config.sandbox.mode,
              cwd,
              ...(config.sandbox.network === undefined ? {} : { network: config.sandbox.network }),
            });
        let r;
        try {
          r = await raceAbort(prepared(), `tool ${tool.name}`);
        } catch (err) {
          if (config.sandbox === undefined || !(err instanceof SandboxDeniedError)) throw err;

          const reason = bound(err.message).display;
          await emit({
            type: "sandbox.denied",
            id: tu.id,
            name: tu.name,
            mode: config.sandbox.mode,
            reason,
          });
          sandboxDenialRecorded = true;

          // A sandbox grant is not a standing tool permission: it crosses a second security axis and
          // must be answered explicitly. The retry bypasses only the sandbox, not input validation,
          // hooks, logging, or the original permission decision, and this non-looping branch gives
          // one call exactly one opportunity to run outside the boundary.
          const escalationReq: PermissionRequest = { ...permReq, origin: "sandbox-escalation" };
          await emit({ type: "permission.request", req: escalationReq });
          await emit({ type: "permission.decision", d: "ask" });
          const escalationDecision = config.onAsk === undefined
            ? "deny"
            : await config.onAsk(escalationReq);
          await emit({ type: "permission.decision", d: escalationDecision });
          if (escalationDecision !== "allow") {
            sandboxRetryDenied = true;
            throw err;
          }

          // Deliberately call the original deferred command, never `prepared`, and never catch this
          // as another escalation. A provider-shaped error from this one retry is an ordinary tool
          // failure because no sandbox was active for it.
          r = await raceAbort(command(), `tool ${tool.name} outside sandbox`);
        }
        const ok = r.isError !== true;
        const overflow = overflowResult(r);
        const resultEvent = await emit({
          type: "tool.result",
          id: tu.id,
          ok,
          display: overflow.display,
          durationMs: now() - t0,
          ...(overflow.output === undefined ? {} : { output: overflow.output, truncated: true }),
        });
        const modelDisplay = overflow.output === undefined
          ? overflow.display
          : displayWithOutputHandle(
              overflow.display,
              overflow.output,
              resultEvent.seq,
              overflow.prefixLimit,
            );
        if (overflow.output !== undefined) {
          // The raw result above preserves the tool's own display. This additive event records the
          // different bounded handle-bearing display the model actually consumes.
          await emit({ type: "tool.result.patched", id: tu.id, by: "core:output-overflow", display: modelDisplay });
        }

        // post_tool: a hook may rewrite what the MODEL sees (redaction, summarising a huge
        // output) or append to it. The `tool.result` event above is already written, so the log
        // keeps what the tool actually returned — a hook can shape the conversation without
        // being able to rewrite history.
        const h = await hook("post_tool", {
          sessionId: id,
          cwd,
          turn: turns,
          tool: { name: tu.name, input },
          // `display` includes the immutable-log handle when output overflowed; `output` remains
          // the tool's own value, which is very often not a string.
          result: { ok, display: modelDisplay, output: r.output },
        });
        for (const bad of h.patches.filter((p) => typeof p !== "string")) {
          await emit({
            type: "error",
            message: `post_tool patch for ${tu.name} must be a string (got ${typeof bad}); ignoring`,
            fatal: false,
          });
        }
        const replaced = h.patches.filter((p): p is string => typeof p === "string").at(-1);
        let body = modelDisplay;
        if (replaced !== undefined || h.injects.length > 0) {
          // An ordinary bounded result keeps every code unit and the injection shrinks to the
          // remaining space. An overflow artifact or replacement shares the frame: half remains
          // available for guidance and half for result context/the recovery handle.
          const rawInjected = h.injects.join("\n");
          const availableAfterResult = Math.max(0, DISPLAY_CAP - modelDisplay.length - 1);
          const injectedBudget = rawInjected === ""
            ? 0
            : overflow.output !== undefined || replaced !== undefined
              ? Math.floor(DISPLAY_CAP / 2)
              : availableAfterResult > 0
                ? availableAfterResult
                : Math.min(Math.floor(DISPLAY_CAP / 2), rawInjected.length);
          const injected = injectedBudget === 0 ? "" : bound(rawInjected, injectedBudget).display;
          const separator = injected === "" ? "" : "\n";
          const baseBudget = DISPLAY_CAP - separator.length - injected.length;
          const base = replaced !== undefined
            ? bound(replaced, baseBudget).display
            : overflow.output !== undefined
              ? displayWithOutputHandle(
                  overflow.display,
                  overflow.output,
                  resultEvent.seq,
                  overflow.prefixLimit,
                  baseBudget,
                )
              : bound(modelDisplay, baseBudget).display;
          // Keep the strict recovery marker last even when guidance is injected; stale-result
          // eviction can then preserve the real core marker rather than marker-shaped tool text.
          body = overflow.output !== undefined && replaced === undefined && injected !== ""
            ? `${injected}${separator}${base}`
            : `${base}${separator}${injected}`;
          // the log keeps what the tool returned; this records that a hook changed what the
          // model consumed, so the two can never diverge unobserved
          await emit({
            type: "tool.result.patched",
            id: tu.id,
            by: "post_tool",
            display: body,
            mode: replaced === undefined ? "inject" : "modify",
          });
        }
        return resultBlock(body, !ok);
      } catch (err) {
        const sandboxDenied = err instanceof SandboxDeniedError && (
          sandboxRetryDenied || (config.sandbox !== undefined && !sandboxDenialRecorded)
        );
        const rawReason =
          abortController.signal.aborted && err instanceof DOMException && err.name === "AbortError"
            ? "aborted"
            : err instanceof Error
              ? err.message
              : String(err);
        // A throw is an unexpected failure, not a successful complete rendering: bound it but do
        // not persist its unbounded message as an artifact. Still run post_tool so redaction hooks
        // cover errors exactly as they cover ordinary tool results.
        const reason = bound(rawReason).display;
        const display = bound(sandboxDenied ? `sandbox denied: ${rawReason}` : rawReason).display;
        if (sandboxDenied && config.sandbox !== undefined && !sandboxDenialRecorded) {
          await emit({
            type: "sandbox.denied",
            id: tu.id,
            name: tu.name,
            mode: config.sandbox.mode,
            reason,
          });
        }
        await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: now() - t0 });
        const h = await hook("post_tool", {
          sessionId: id,
          cwd,
          turn: turns,
          tool: { name: tu.name, input },
          result: { ok: false, display, output: undefined },
        });
        for (const bad of h.patches.filter((patch) => typeof patch !== "string")) {
          await emit({
            type: "error",
            message: `post_tool patch for ${tu.name} must be a string (got ${typeof bad}); ignoring`,
            fatal: false,
          });
        }
        const replaced = h.patches.filter((patch): patch is string => typeof patch === "string").at(-1);
        const rawInjected = h.injects.join("\n");
        const availableAfterError = Math.max(0, DISPLAY_CAP - display.length - 1);
        const injectedBudget = rawInjected === ""
          ? 0
          : availableAfterError > 0
            ? availableAfterError
            : Math.min(Math.floor(DISPLAY_CAP / 2), rawInjected.length);
        const injected = injectedBudget === 0 ? "" : bound(rawInjected, injectedBudget).display;
        const separator = injected === "" ? "" : "\n";
        const base = bound(replaced ?? display, DISPLAY_CAP - separator.length - injected.length).display;
        const body = `${base}${separator}${injected}`;
        if (replaced !== undefined || h.injects.length > 0) {
          await emit({
            type: "tool.result.patched",
            id: tu.id,
            by: "post_tool",
            display: body,
            mode: replaced === undefined ? "inject" : "modify",
          });
        }
        return resultBlock(body, true);
      }
    }
  })();

  return {
    id,
    events: stream,
    control: {
      steer: (message, source = "user") => pendingSteers.push({ message, source }),
      pause: () => gate.pause(),
      resume: () => gate.resume(),
      abort: () => {
        // an abort while the session is already ending is the second one: stop the end hooks too
        if (ending || abortController.signal.aborted) endController.abort();
        abortController.abort();
        gate.resume();
      },
      requirePlan: (reason) => {
        replanReason = reason;
        replanRefusals = 0;
      },
      planRequired: () => replanReason !== null,
      canRequirePlan: () => hasPlanTool,
      record: (payload) => {
        if (ended) return;
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
