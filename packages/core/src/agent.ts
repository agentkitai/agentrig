import { zodToJsonSchema } from "zod-to-json-schema";
import type { Decision, EventPayload, HarnessEvent, PermissionRequest, Usage } from "./events.js";
import { SupervisorRecord } from "./events.js";
import type { ContentBlock, Message } from "./messages.js";
import type { ModelProvider, ModelRequest, StopReason, ToolSpec } from "./provider.js";
import type { PermissionPolicy } from "./permissions.js";
import type { AnyTool, ToolContext } from "./tool.js";
import { type CompactionStrategy, summarizeOlderTurns } from "./compaction.js";
import { SessionStore, assertSessionId, contentHash } from "./session-store.js";
import { mergePatches, runHooks, type Hook, type HookPoint } from "./hooks.js";
import { appendProjectInstructions, discoverProjectInstructions } from "./project-context.js";

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
}

export interface PromptContext {
  task: string;
  cwd: string;
}

export interface AgentConfig {
  provider: ModelProvider;
  tools: AnyTool[];
  permissions: PermissionPolicy;
  systemPrompt: string | ((ctx: PromptContext) => string);
  /** Every event goes through this store; the session log is the source of truth. */
  store: SessionStore;
  budget?: Budget;
  pricing?: Pricing;
  /**
   * Defaults to `summarizeOlderTurns()` (PLAN §2.8). The summarization call goes straight to the
   * provider and is not metered by the budget — its cost is the price of staying under the window.
   */
  compaction?: CompactionStrategy;
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
}

export interface Agent {
  /**
   * `resume` continues an existing session from its snapshot: same id, same JSONL log
   * (seq continues), prior messages restored, `task` appended as a fresh user message.
   */
  run(task: string, opts?: RunOptions): Session;
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

export function createAgent(config: AgentConfig): Agent {
  return { run: (task, opts) => runSession(config, task, opts ?? {}) };
}

function runSession(config: AgentConfig, task: string, opts: RunOptions): Session {
  const { store, provider } = config;
  const now = config.now ?? (() => Date.now());
  // a resumed id is user input (`--resume <id>`) and becomes a filename; reject it here rather
  // than letting it reach the filesystem or a session_end hook that builds a path from it
  const resume = opts.resume === undefined ? undefined : assertSessionId(opts.resume);
  const id = resume ?? (opts.id === undefined ? store.create() : assertSessionId(opts.id));
  // A fresh run owns its log for its lifetime. Two runs appending to one id would restart `seq`
  // and leave a log that cannot be read back at all — which a caller-supplied `id` makes possible
  // for a fresh session, where the resume path's advisory file lock does not apply.
  const releaseClaim = resume === undefined ? store.claim(id) : null;
  let cwd = opts.cwd ?? process.cwd();
  const stream = new EventStream();
  const gate = new PauseGate();
  const abortController = new AbortController();
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
    // a plan landing satisfies the gate, no matter which tool or path produced it
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
  const emitFromTool = (payload: EventPayload): void => {
    if (!ended) void emit(payload);
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
    return runHooks(
      {
        hooks,
        signal: abortController.signal,
        // one wall-clock budget for the whole point, so generous per-hook overrides cannot add up
        totalTimeoutMs: point === "session_end" ? (config.sessionEndBudgetMs ?? 15 * 60_000) : 60_000,
        ...(config.hookTimeoutMs === undefined ? {} : { timeoutMs: config.hookTimeoutMs }),
        onError: (message) => {
          if (!ended) void emit({ type: "error", message, fatal: false });
        },
      },
      point,
      { ...ctx, signal: abortController.signal },
    );
  };

  /** Lets `control.abort()` win over a tool that ignores its signal. */
  const raceAbort = <T>(work: Promise<T>): Promise<T> => {
    const signal = abortController.signal;
    if (signal.aborted) {
      work.catch(() => {});
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return new Promise<T>((res, rej) => {
      const onAbort = () => rej(new DOMException("aborted", "AbortError"));
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

    const toolsByName = new Map(config.tools.map((t) => [t.name, t]));
    const toolSpecs = config.tools.map(toToolSpec);
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
      if (b.maxTokens !== undefined && totals.input + totals.output >= b.maxTokens)
        return `token budget reached (${b.maxTokens})`;
      if (b.maxUsd !== undefined && usd >= b.maxUsd) return `USD budget reached ($${b.maxUsd})`;
      if (b.maxMinutes !== undefined && now() - startedAt >= b.maxMinutes * 60_000)
        return `time budget reached (${b.maxMinutes}m)`;
      return null;
    };

    try {
      if (resume !== undefined) {
        const snap = await store.readSnapshot(id);
        if (snap === null) throw new Error(`cannot resume session ${id}: no snapshot found`);
        cwd = opts.cwd ?? snap.cwd;
        turns = snap.turns;
        usd = snap.usd ?? 0;
        totals.input = snap.usage.input;
        totals.output = snap.usage.output;
        if (snap.usage.cacheRead !== undefined) totals.cacheRead = snap.usage.cacheRead;
        if (snap.usage.cacheWrite !== undefined) totals.cacheWrite = snap.usage.cacheWrite;
        await emit({ type: "session.resume", task, cwd, provider: provider.id, model: provider.model });
        messages = snap.messages;
        if (task !== "") messages.push({ role: "user", content: [{ type: "text", text: task }] });
      } else {
        await emit({ type: "session.start", task, cwd, provider: provider.id, model: provider.model });
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
        for (const text of extra) messages.push({ role: "user", content: [{ type: "text", text }] });
      }
      system = typeof config.systemPrompt === "function" ? config.systemPrompt({ task, cwd }) : config.systemPrompt;
      const projectInstructions = await discoverProjectInstructions(cwd);
      if (projectInstructions !== null) {
        system = appendProjectInstructions(system, projectInstructions);
        await emit({
          type: "context.loaded",
          path: projectInstructions.path,
          bytes: projectInstructions.bytes,
        });
      }

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
        await emit({ type: "model.request", tokensIn: estimateTokens(system, messages) });

        const req: ModelRequest = {
          system,
          messages,
          tools: toolSpecs,
          maxTokens: config.maxTokensPerTurn ?? 8192,
          cacheHints: { systemPrefix: true },
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
              req.system = patch.system;
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
          usd +=
            (usage.input * config.pricing.inputUsdPerMTok + usage.output * config.pricing.outputUsdPerMTok) / 1e6;
        }
        if (usage.input + usage.output === 0 && stop !== "error" && !warnedNoUsage) {
          // e.g. an OpenAI-compatible server ignoring stream_options: budgets can't bind on zeros
          warnedNoUsage = true;
          await emit({
            type: "error",
            message: "provider reported no token usage; token and USD budgets will not bind this session",
            fatal: false,
          });
        }

        flushText();
        if (assistantContent.length > 0) messages.push({ role: "assistant", content: assistantContent });

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
        messages.push({ role: "user", content: results });

        // Fall back to the estimate when the provider reports no usage, so compaction still
        // fires for servers that never send a usage chunk.
        const contextTokens = usage.input + usage.output || estimateTokens(system, messages);
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
            const compacted = await raceAbort(compaction.compact(messages, provider, abortController.signal));
            const after = estimateTokens(system, compacted);
            if (compacted !== messages && after < before * 0.9) {
              messages = compacted;
              await emit({ type: "context.compact", before, after });
            } else {
              // no progress possible (tail alone exceeds the window): warn once, stop retrying —
              // a summarization call every turn that can't shrink anything is pure burn
              if (compacted !== messages) messages = compacted;
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
        emit: emitFromTool,
        signal: abortController.signal,
      };
      const t0 = now();
      try {
        const r = await raceAbort(tool.execute(input, ctx));
        const ok = r.isError !== true;
        await emit({ type: "tool.result", id: tu.id, ok, display: r.display, durationMs: now() - t0 });

        // post_tool: a hook may rewrite what the MODEL sees (redaction, summarising a huge
        // output) or append to it. The `tool.result` event above is already written, so the log
        // keeps what the tool actually returned — a hook can shape the conversation without
        // being able to rewrite history.
        const h = await hook("post_tool", {
          sessionId: id,
          cwd,
          turn: turns,
          tool: { name: tu.name, input },
          // `display` is the string the model sees and the one a patch replaces; `output` is the
          // tool's own value, which is very often not a string
          result: { ok, display: r.display, output: r.output },
        });
        for (const bad of h.patches.filter((p) => typeof p !== "string")) {
          await emit({
            type: "error",
            message: `post_tool patch for ${tu.name} must be a string (got ${typeof bad}); ignoring`,
            fatal: false,
          });
        }
        const replaced = h.patches.filter((p): p is string => typeof p === "string").at(-1);
        const body = [replaced ?? r.display, ...h.injects].join("\n");
        if (replaced !== undefined || h.injects.length > 0) {
          // the log keeps what the tool returned; this records that a hook changed what the
          // model consumed, so the two can never diverge unobserved
          await emit({ type: "tool.result.patched", id: tu.id, by: "post_tool", display: body });
        }
        return resultBlock(body, !ok);
      } catch (err) {
        const display =
          abortController.signal.aborted && err instanceof DOMException && err.name === "AbortError"
            ? "aborted"
            : err instanceof Error
              ? err.message
              : String(err);
        await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: now() - t0 });
        return resultBlock(display, true);
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
