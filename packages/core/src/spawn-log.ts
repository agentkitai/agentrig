import type { HarnessEvent } from "./events.js";
import type { SessionStore } from "./session-store.js";

export type SpawnLogEntry = Extract<HarnessEvent, { type: "subagent.spawn" }>;
export interface SpawnLogQuery {
  childId?: string;
  role?: string;
}

/**
 * Query physical, immutable spawn records for one parent, in append order.
 * Does not expand forks, consult live children, or write/backfill events. Legacy
 * records can lack role and taskText; task remains the historical display label.
 * Strict SessionStore decoding propagates invalid IDs and corrupt logs as errors.
 */
export async function querySpawnLog(store: SessionStore, parent: string, query: SpawnLogQuery = {}): Promise<SpawnLogEntry[]> {
  const entries: SpawnLogEntry[] = [];
  for await (const event of store.read(parent)) {
    if (event.type !== "subagent.spawn") continue;
    if (query.childId !== undefined && event.id !== query.childId) continue;
    if (query.role !== undefined && event.role?.name !== query.role) continue;
    entries.push(event);
  }
  return entries;
}
