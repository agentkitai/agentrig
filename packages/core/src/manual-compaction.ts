import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentConfig, Session, SessionSummary } from "./agent.js";
import { compactWithProvenance, summarizeOlderTurns } from "./compaction.js";
import { ADVISORY_CONTEXT } from "./context-principals.js";
import { runHooks } from "./hooks.js";
import type { Message } from "./messages.js";
import type { ModelProvider } from "./provider.js";
import { abortGraceOf, createSessionLifecycle } from "./session-lifecycle.js";
import { assertSessionId } from "./session-store.js";
import { SpendCapError, hasSpendMeter } from "./spend-ledger.js";
import { bindSessionSpend, currentSpend, withSpendRun } from "./spend-runtime.js";

export interface CompactOptions { resume: string; cwd?: string; signal?: AbortSignal }
export interface CompactResult {
  compacted: boolean;
  parent: string;
  id: string;
  message: string;
  beforeBytes: number;
  afterBytes: number;
  summary: SessionSummary;
}
export interface CompactionSession extends Session { result: Promise<CompactResult> }

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
function transcriptBytes(messages: Message[]): number {
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  if (messages.length > 10_000 || bytes > MAX_TRANSCRIPT_BYTES) throw new Error("compaction transcript exceeds limits");
  return bytes;
}

/** Explicit maintenance, not a normal user turn. A failed child never replaces its parent. */
export function compactSession(config: AgentConfig, options: CompactOptions): Promise<CompactionSession> {
  return withSpendRun(config.spend?.ledger, async () => {
    const parent = assertSessionId(options.resume);
    if (config.budget?.maxTokens !== undefined || config.budget?.maxUsd !== undefined)
      throw new Error("manual compaction cannot enforce legacy total-token/USD caps; no model call was made");
    const timeout = Math.min(60_000, (config.budget?.maxMinutes ?? 1) * 60_000);
    const maxTokens = Math.min(1024, config.maxTokensPerTurn ?? 1024);
    if (!Number.isFinite(timeout) || timeout < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1)
      throw new Error("invalid manual compaction bounds");
    options.signal?.throwIfAborted();
    const store = config.store;
    const releaseParent = await store.acquireLock(parent);
    let releaseChild: (() => Promise<void>) | undefined;
    let releaseClaim: (() => void) | undefined;
    let handedOff = false;
    try {
      const events = await store.readAll(parent);
      const last = events.at(-1);
      if (last?.type !== "session.end") throw new Error("manual compaction requires a closed conversation");
      const snapshot = await store.readSnapshot(parent) ?? await store.materializeSnapshot(parent);
      if (snapshot === null || snapshot.sessionId !== parent) throw new Error("manual compaction requires a valid snapshot");
      const cwd = await realpath(options.cwd ?? snapshot.cwd);
      if (cwd !== await realpath(snapshot.cwd)) throw new Error("manual compaction cwd differs from the saved conversation");
      const beforeBytes = transcriptBytes(snapshot.messages);
      options.signal?.throwIfAborted();
      const id = await store.fork(parent, last.seq);
      releaseClaim = store.claim(id);
      releaseChild = await store.acquireLock(id);
      const lifecycle = createSessionLifecycle(store, id, abortGraceOf(config), () => {});
      const { emit, abortController } = lifecycle;
      const spend = currentSpend();
      if (spend !== undefined) {
        spend.session = id;
        spend.onCap = async error => { if (!lifecycle.isEnded()) await emit({ type: "budget.cap", reason: error.reason, segment: spend.segment }); };
        spend.onUnavailable = async () => {
          if (spend.unavailable) return;
          spend.unavailable = true;
          if (!lifecycle.isEnded()) await emit({ type: "error", message: "manual compaction accounting unavailable; coverage unknown", fatal: false });
        };
      }
      const abort = () => lifecycle.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(abort, timeout);
      const result = (async (): Promise<CompactResult> => {
        let reason: SessionSummary["reason"] = "done";
        let message = "No context reduction; original conversation remains selected.";
        let changed = false;
        let afterBytes = beforeBytes;
        let compacted = snapshot.messages;
        try {
          await emit({ type: "session.resume", task: "", cwd, provider: config.provider.id, model: config.provider.model,
            turns: snapshot.turns, context: ADVISORY_CONTEXT, maintenance: "compact" });
          abortController.signal.throwIfAborted();
          if (config.spend !== undefined && spend !== undefined && !hasSpendMeter(config.provider, config.spend.ledger, config.spend.capMicros)) {
            try { await config.spend.ledger.gap(spend.segment, id); } catch { await spend.onUnavailable?.(); }
          }
          if (config.spend?.capMicros !== undefined) {
            try { await config.spend.ledger.check(config.spend.capMicros, abortController.signal); }
            catch (error) {
              if (!abortController.signal.aborted) await spend?.onCap?.(error instanceof SpendCapError ? error : new SpendCapError("unavailable"));
              throw error;
            }
          }
          const hook = await lifecycle.raceAbort(runHooks({ hooks: config.hooks ?? [], signal: abortController.signal,
            totalTimeoutMs: timeout, ...(config.hookTimeoutMs === undefined ? {} : { timeoutMs: config.hookTimeoutMs }),
            failClosed: true, onError: () => {} }, "pre_compact", {
            sessionId: id, cwd, turn: snapshot.turns, messages: structuredClone(snapshot.messages), signal: abortController.signal,
          }), "manual pre-compaction hooks");
          if (hook.denied !== undefined) message = "Compaction vetoed; original conversation remains selected.";
          else {
            let calls = 0;
            const bounded: ModelProvider = { id: config.provider.id, model: config.provider.model, capabilities: config.provider.capabilities,
              async *stream(request, signal) {
                if (++calls > 1) throw new Error("manual compaction permits one provider call");
                let bytes = 0;
                for await (const event of config.provider.stream({ ...request, maxTokens: Math.min(maxTokens, request.maxTokens) },
                  AbortSignal.any([abortController.signal, signal]))) {
                  if (event.type === "text_delta") {
                    bytes += Buffer.byteLength(event.text);
                    if (bytes > 262_144) throw new Error("manual summary exceeds output limit");
                  }
                  yield event;
                }
              } };
            compacted = await lifecycle.raceAbort(compactWithProvenance(config.compaction ?? summarizeOlderTurns({ maxSummaryTokens: maxTokens }),
              snapshot.messages, bounded, abortController.signal), "manual compaction");
            abortController.signal.throwIfAborted();
            afterBytes = transcriptBytes(compacted);
            changed = !isDeepStrictEqual(compacted, snapshot.messages) && afterBytes < beforeBytes;
            if (changed) {
              await emit({ type: "context.compact", before: Math.ceil(beforeBytes / 4), after: Math.ceil(afterBytes / 4), messages: compacted,
                estimate: { scope: "transcript", beforeBytes, afterBytes } });
              abortController.signal.throwIfAborted();
              await store.writeSnapshot({ ...snapshot, sessionId: id, messages: compacted, ts: Date.now() });
              abortController.signal.throwIfAborted();
              message = "Compacted fork saved; original conversation is unchanged.";
            }
          }
        } catch (error) {
          reason = abortController.signal.aborted ? "aborted" : error instanceof SpendCapError ? "budget" : "error";
          changed = false;
          message = `Compaction ${reason}; original conversation remains selected. Child ${id} is unadopted diagnostic history.`;
          await emit({ type: "error", message, fatal: true }).catch(() => {});
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          lifecycle.beginEnding();
          await lifecycle.settleOrphans();
          if (spend !== undefined && config.spend !== undefined) {
            try {
              if (spend.unavailable) await config.spend.ledger.gap(spend.segment, id, "accounting-unavailable");
              await config.spend.ledger.end(spend.segment, id);
            } catch { if (config.spend.capMicros !== undefined) { reason = "error"; changed = false; } }
          }
          await lifecycle.finish(reason, releaseChild ?? null, releaseClaim ?? null);
          try { await releaseParent(); } catch { reason = "error"; changed = false; }
        }
        // finish intentionally contains append failures for ordinary sessions. Maintenance must
        // verify its new journal/cache before publishing the new conversation identity.
        if (changed) try {
          const releaseVerification = await store.acquireLock(id);
          try {
            const saved = await store.readSnapshot(id);
            const own = await store.readAll(id);
            const terminal = own.at(-1);
            if (terminal?.type !== "session.end" || terminal.reason !== "done" ||
              saved === null || !isDeepStrictEqual(saved.messages, compacted) ||
              !isDeepStrictEqual(await store.materializeMessages(id), compacted)) throw new Error("incomplete compacted fork");
          } finally { await releaseVerification(); }
        } catch { reason = "error"; changed = false; message = `Compaction persistence incomplete; original remains selected. Child ${id} is unadopted.`; }
        if (!changed && reason === "error") message = `Compaction failed; original remains selected. Child ${id} is unadopted diagnostic history.`;
        if (options.signal?.aborted) { reason = "aborted"; changed = false; message = `Compaction cancelled; original remains selected. Child ${id} is unadopted.`; }
        return { compacted: changed, parent, id, beforeBytes, afterBytes, message,
          summary: { id, reason, turns: snapshot.turns, usage: { ...snapshot.usage } } };
      })();
      const session: CompactionSession = { id, events: lifecycle.stream, result, done: result.then(value => value.summary),
        control: { auxiliarySignal: lifecycle.auxiliaryController.signal, abort, steer: () => {}, pause: () => {}, resume: () => {},
          record: () => {}, requirePlan: () => {}, planRequired: () => false, canRequirePlan: () => false } };
      bindSessionSpend(session);
      try { void Promise.resolve(config.observeSession?.(session)).catch(() => {}); } catch { /* observation is not publication */ }
      handedOff = true;
      return session;
    } finally {
      if (!handedOff) { await releaseChild?.(); releaseClaim?.(); await releaseParent(); }
    }
  });
}
