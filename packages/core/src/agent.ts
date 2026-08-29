import { zodToJsonSchema } from "zod-to-json-schema";
import type { Decision, EventPayload, HarnessEvent, PermissionRequest, Usage } from "./events.js";
import type { ContentBlock, Message } from "./messages.js";
import type { ModelProvider, ModelRequest, StopReason, ToolSpec } from "./provider.js";
import type { PermissionPolicy } from "./permissions.js";
import type { AnyTool, ToolContext } from "./tool.js";
import { type CompactionStrategy, summarizeOlderTurns } from "./compaction.js";
import { SessionStore, contentHash } from "./session-store.js";

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
  steer(message: string, source?: "user" | "supervisor"): void;
  pause(): void;
  resume(): void;
  abort(): void;
}

export interface Session {
  id: string;
  events: AsyncIterable<HarnessEvent>;
  control: SessionControl;
  done: Promise<SessionSummary>;
}

export interface Agent {
  /**
   * `resume` continues an existing session from its snapshot: same id, same JSONL log
   * (seq continues), prior messages restored, `task` appended as a fresh user message.
   */
  run(task: string, opts?: { cwd?: string; resume?: string }): Session;
}

export function toToolSpec(tool: AnyTool): ToolSpec {
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

export function createAgent(config: AgentConfig): Agent {
  return { run: (task, opts) => runSession(config, task, opts ?? {}) };
}

function runSession(config: AgentConfig, task: string, opts: { cwd?: string; resume?: string }): Session {
  const { store, provider } = config;
  const now = config.now ?? (() => Date.now());
  const resume = opts.resume;
  const id = resume ?? store.create();
  let cwd = opts.cwd ?? process.cwd();
  const stream = new EventStream();
  const gate = new PauseGate();
  const abortController = new AbortController();
  const pendingSteers: Array<{ message: string; source: "user" | "supervisor" }> = [];

  // All appends go through one promise chain so events written by tools (via ctx.emit)
  // and by the loop land in the store — and in `seq` — in the order they were emitted.
  let chain: Promise<unknown> = Promise.resolve();
  let ended = false;
  const emit = (payload: EventPayload): Promise<HarnessEvent> => {
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
      system = typeof config.systemPrompt === "function" ? config.systemPrompt({ task, cwd }) : config.systemPrompt;

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
          try {
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

      const parsed = tool.inputSchema.safeParse(tu.input);
      if (!parsed.success) {
        const display = `invalid input for ${tu.name}: ${parsed.error.message}`;
        await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
        await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: 0 });
        return resultBlock(display, true);
      }
      const input = parsed.data;

      const permClass = typeof tool.permission === "function" ? tool.permission(input) : tool.permission;
      const declaredPaths = tool.paths?.(input);
      const permReq: PermissionRequest = {
        tool: tu.name,
        input,
        class: permClass,
        cwd,
        ...(declaredPaths === undefined ? {} : { paths: declaredPaths }),
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
        return resultBlock(r.display, !ok);
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
    },
    done,
  };
}
