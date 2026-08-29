import type { DistilledFact } from "./ingest.js";
import type { WikiPage } from "./types.js";

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

export interface MemoryBackend {
  id: string;
  onIngest(facts: DistilledFact[], source: SourceRef): Promise<void>;
  recall(query: string, k: number): Promise<BackendHit[]>;
  promote(page: WikiPage): Promise<void>;
  conflicts?(facts: DistilledFact[]): Promise<Conflict[]>;
}

/**
 * Wrap a backend so no failure can propagate. Every method resolves: writes become no-ops,
 * reads become empty. `onError` sees what happened, so a CLI can print it and a dream can log
 * it — silent-but-visible rather than silent-and-lost.
 */
export function tolerant(backend: MemoryBackend, onError: (op: string, err: Error) => void): MemoryBackend {
  const guard = async <T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      onError(op, err instanceof Error ? err : new Error(String(err)));
      return fallback;
    }
  };
  const wrapped: MemoryBackend = {
    id: backend.id,
    onIngest: (facts, source) => guard("onIngest", () => backend.onIngest(facts, source), undefined),
    recall: (query, k) => guard("recall", () => backend.recall(query, k), []),
    promote: (page) => guard("promote", () => backend.promote(page), undefined),
  };
  if (backend.conflicts !== undefined) {
    const conflicts = backend.conflicts.bind(backend);
    wrapped.conflicts = (facts) => guard("conflicts", () => conflicts(facts), []);
  }
  return wrapped;
}

/** Provenance into the wiki: a fact line records which backend memory it corresponds to. */
export function backendRef(backendId: string, memoryId: string): string {
  return `${backendId}:${memoryId}`;
}
