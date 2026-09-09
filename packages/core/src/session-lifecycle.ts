import type { EventPayload, HarnessEvent } from "./events.js";
import type { SessionSummary } from "./agent.js";
import type { SessionStore } from "./session-store.js";

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

/**
 * Internal per-session owner of ordering, cancellation and terminal resource release.
 *
 * `graceMs` is the NORMALIZED abort grace in milliseconds — already through `abortGraceOf`, so it
 * is a finite non-negative number and never `AgentConfig.abortGraceMs`'s raw optional value. This
 * signature takes the normalized number rather than the config on purpose: the loop and the
 * subagent tool (which halves its parent's grace for a child) both normalize first, and a second
 * `?? DEFAULT_ABORT_GRACE_MS` inside here would silently turn a deliberate `0` into a full second.
 * Zero is a legitimate value and means "do not wait for orphans at all".
 */
export function createSessionLifecycle(store: SessionStore, id: string, graceMs: number, onEmit: (payload: EventPayload) => void) {
  const stream = new EventStream();
  const gate = new PauseGate();
  const abortController = new AbortController();
  const auxiliaryController = new AbortController();
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
  // All appends go through one promise chain so events written by tools (via ctx.emit)
  // and by the loop land in the store — and in `seq` — in the order they were emitted.
  let chain: Promise<unknown> = Promise.resolve();
  let ended = false;
  const emit = (payload: EventPayload): Promise<HarnessEvent> => {
    onEmit(payload);
    const p = chain.then(() => store.append(id, payload)).then((e) => {
      stream.push(e);
      return e;
    });
    chain = p.catch(() => {});
    return p;
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
  // The caller normalizes graceMs through abortGraceOf before creating the lifecycle.
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

  const beginEnding = (): void => {
    ending = true;
    auxiliaryController.abort(new DOMException("session main work ended", "AbortError"));
  };
  const finish = async (reason: SessionSummary["reason"], releaseLock: (() => Promise<void>) | null, releaseClaim: (() => void) | null): Promise<void> => {
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
  };
  const abort = (): void => {
    auxiliaryController.abort(new DOMException("session aborted", "AbortError"));
    if (ending || abortController.signal.aborted) endController.abort();
    abortController.abort();
    gate.resume();
  };
  return { stream, gate, abortController, auxiliaryController, endController, emit, raceAbort,
    settleOrphans, beginEnding, finish, abort, isEnded: () => ended };
}
