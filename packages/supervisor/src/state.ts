import type { HarnessEvent, PlanItem, Usage } from "@agentkitai/agentrig-core";

/**
 * What every detector can see without keeping its own copy of the stream. Detectors that need
 * cross-event bookkeeping (which hash repeated how often) keep it privately; this is the shared
 * part. Fields are only ever added — PLAN's schema rule applies here too, because a detector
 * written against an older shape must keep working.
 */
export interface SupervisorState {
  /** Rolling window of recent events; detectors decide how much they need. */
  recent: HarnessEvent[];
  turns: number;
  filesChanged: number;
  toolErrors: number;
  lastInterventionSeq: number | null;
  // --- added in M4 ---
  toolCalls: number;
  usage: Usage;
  usd: number;
  /** ts of `session.start` / `session.resume`, and of the latest event, so budget can do wall clock. */
  startedAt: number | null;
  lastTs: number;
  /** Latest `plan.updated` items; the drift detector reads their `scope`. */
  plan: PlanItem[];
  /** Set once the session has ended — attach() stops applying interventions past this point. */
  ended: boolean;
  /** Current event's write-result-backed claims. Empty for uncorroborated/legacy claims. */
  corroboratedChanges?: Array<Extract<HarnessEvent, { type: "file.changed" }>>;
  cwd?: string;
}

type PendingChange = Extract<HarnessEvent, { type: "file.changed" }>;
const pendingWrites = new WeakMap<SupervisorState, Map<number, { id: string; changes: PendingChange[] }>>();

export interface StateOptions {
  /** How many events to retain in `recent`. Bounded so a long session cannot grow without limit. */
  windowSize?: number;
  /** USD per million tokens, so the budget detector can price a soft threshold. */
  pricing?: {
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    cacheReadUsdPerMTok?: number;
    cacheWriteUsdPerMTok?: number;
  };
  /** Provider fallbacks when pricing does not give explicit cache rates. */
  cacheReadDiscount?: number;
  cacheWriteMultiplier?: number;
}

export const DEFAULT_WINDOW = 400;

export function initialState(): SupervisorState {
  return {
    recent: [],
    turns: 0,
    filesChanged: 0,
    toolErrors: 0,
    lastInterventionSeq: null,
    toolCalls: 0,
    usage: { input: 0, output: 0 },
    usd: 0,
    startedAt: null,
    lastTs: 0,
    plan: [],
    ended: false,
  };
}

/** Folds one event into the state, in place. Must run before the detectors see that event. */
export function reduce(state: SupervisorState, event: HarnessEvent, opts: StateOptions = {}): void {
  state.corroboratedChanges = [];
  let pending = pendingWrites.get(state);
  if (pending === undefined) { pending = new Map(); pendingWrites.set(state, pending); }
  if (["turn.start", "turn.end", "session.start", "session.resume", "session.end"].includes(event.type)) pending.clear();
  const window = opts.windowSize ?? DEFAULT_WINDOW;
  state.recent.push(event);
  if (state.recent.length > window) state.recent.splice(0, state.recent.length - window);
  state.lastTs = event.ts;

  switch (event.type) {
    case "session.start":
      state.startedAt = event.ts;
      state.cwd = event.cwd;
      break;
    case "session.resume":
      // A resumed session restarts the wall clock, but its hard turn budget is cumulative. Seeding
      // this before the first model request lets a near-cap resume receive guidance before it spends
      // its final turn. `turns` is optional for compatibility with old event logs.
      state.startedAt = event.ts;
      state.cwd = event.cwd;
      state.turns = event.turns ?? state.turns;
      break;
    case "session.end":
      state.ended = true;
      break;
    case "turn.end":
      // `n` is cumulative across resumes, just like core's hard turn budget. Taking the greater of
      // the event count and the locally observed increment also keeps the fold robust to synthetic
      // or legacy streams whose turn.end events all used n=1.
      state.turns = Math.max(state.turns + 1, event.n);
      break;
    case "tool.call":
      state.toolCalls += 1;
      pending.set(event.seq, { id: event.id, changes: [] });
      while (pending.size > 400) pending.delete(pending.keys().next().value!);
      break;
    case "tool.result":
      if (!event.ok) state.toolErrors += 1;
      if (event.toolCallSeq !== undefined) {
        const call = pending.get(event.toolCallSeq);
        pending.delete(event.toolCallSeq);
        if (call?.id === event.id && event.ok && event.permission === "write") {
          state.corroboratedChanges = call.changes;
          state.filesChanged += call.changes.length;
        }
      }
      break;
    case "file.changed":
      if (event.toolCallSeq !== undefined) {
        const call = pending.get(event.toolCallSeq);
        if (call !== undefined && call.changes.length < 400) call.changes.push(event);
      }
      break;
    case "model.response":
      state.usage.input += event.usage.input;
      state.usage.output += event.usage.output;
      if (event.usage.cacheRead !== undefined) {
        state.usage.cacheRead = (state.usage.cacheRead ?? 0) + event.usage.cacheRead;
      }
      if (event.usage.cacheWrite !== undefined) {
        state.usage.cacheWrite = (state.usage.cacheWrite ?? 0) + event.usage.cacheWrite;
      }
      if (opts.pricing !== undefined) {
        const readPrice = opts.pricing.cacheReadUsdPerMTok
          ?? opts.pricing.inputUsdPerMTok * (opts.cacheReadDiscount ?? 1);
        const writePrice = opts.pricing.cacheWriteUsdPerMTok
          ?? opts.pricing.inputUsdPerMTok * (opts.cacheWriteMultiplier ?? 1);
        state.usd += (
          event.usage.input * opts.pricing.inputUsdPerMTok
          + (event.usage.cacheRead ?? 0) * readPrice
          + (event.usage.cacheWrite ?? 0) * writePrice
          + event.usage.output * opts.pricing.outputUsdPerMTok
        ) / 1e6;
      }
      break;
    case "plan.updated":
      state.plan = event.items;
      break;
    case "supervisor.intervention":
      state.lastInterventionSeq = event.seq;
      break;
    default:
      break;
  }
}
