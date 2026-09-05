import type { DistilledFact } from "./ingest.js";
import type { WikiPage } from "./types.js";
import { maintenanceDiagnostic } from "./maintenance.js";

/**
 * The optional backend seam (PLAN §3.8).
 *
 * The wiki is the source of truth. A backend is a *sink and an extra recall source* — never a
 * replacement, never a dependency. The default configuration has none, and every call here is
 * best-effort: a backend that is down, slow, or misconfigured must not block ingest, query, or
 * dream, and must never be able to lose a fact the wiki already holds.
 */

export interface SourceRef {
  /** e.g. `session:8f2a` or `doc:adr-012`. */
  ref: string;
  /** Project name, for scoping on the backend side. */
  project: string;
  /** Wiki page the facts were written to, when they map to one. */
  page?: string;
}

export interface BackendHit {
  /** Backend-native id, used for provenance back into the wiki (`lore:<id>`). */
  id: string;
  text: string;
  score: number;
  /** Wiki page this memory came from, when the backend knows. */
  page?: string;
}

export interface Conflict {
  /** The fact we were about to record. */
  fact: string;
  /** What the backend already believes. */
  existing: string;
  existingId: string;
  detail?: string;
}

/** What a backend stored for one fact, so the wiki can record provenance back to it. */
export interface BackendAck {
  factText: string;
  memoryId: string;
}

export interface BackendCallOptions { signal?: AbortSignal }

export interface MemoryBackend {
  id: string;
  /** Returns the ids assigned to each fact, for the `lore:<memory-id>` half of provenance. */
  onIngest(facts: DistilledFact[], source: SourceRef, opts?: BackendCallOptions): Promise<BackendAck[]>;
  recall(query: string, k: number, opts?: BackendCallOptions): Promise<BackendHit[]>;
  promote(page: WikiPage, opts?: BackendCallOptions): Promise<void>;
  conflicts?(facts: DistilledFact[], opts?: BackendCallOptions): Promise<Conflict[]>;
}

export interface TolerantOptions {
  /**
   * Abandon a call after this long (default 15s). Guarding rejections is not enough: a backend
   * whose promise never settles would otherwise block ingest and search forever, which is the
   * exact opposite of what this wrapper promises.
   */
  timeoutMs?: number;
}

/**
 * Wrap a backend so no failure can propagate. Every method resolves: writes become no-ops,
 * reads become empty. `onError` sees what happened, so a CLI can print it and a dream can log
 * it — silent-but-visible rather than silent-and-lost.
 */
export function tolerant(
  backend: MemoryBackend,
  onError: (op: string, err: Error) => void,
  opts: TolerantOptions = {},
): MemoryBackend {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // a throwing logger must not become the failure it was reporting
  const report = (op: string, err: Error) => {
    maintenanceDiagnostic(() => onError(op, err));
  };
  const guard = async <T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      report(op, err instanceof Error ? err : new Error(String(err)));
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const wrapped: MemoryBackend = {
    id: backend.id,
    onIngest: (facts, source, options) => guard("onIngest", () => backend.onIngest(facts, source, options), []),
    recall: (query, k, options) => guard("recall", () => backend.recall(query, k, options), []),
    promote: (page, options) => guard("promote", () => backend.promote(page, options), undefined),
  };
  if (backend.conflicts !== undefined) {
    const conflicts = backend.conflicts.bind(backend);
    wrapped.conflicts = (facts, options) => guard("conflicts", () => conflicts(facts, options), []);
  }
  return wrapped;
}

/** Provenance into the wiki: a fact line records which backend memory it corresponds to. */
export function backendRef(backendId: string, memoryId: string): string {
  return `${backendId}:${memoryId}`;
}
