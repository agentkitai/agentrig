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
}

export interface StateOptions {
  /** How many events to retain in `recent`. Bounded so a long session cannot grow without limit. */
  windowSize?: number;
  /** USD per million tokens, so the budget detector can price a soft threshold. */
  pricing?: { inputUsdPerMTok: number; outputUsdPerMTok: number };
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
  const window = opts.windowSize ?? DEFAULT_WINDOW;
  state.recent.push(event);
  if (state.recent.length > window) state.recent.splice(0, state.recent.length - window);
  state.lastTs = event.ts;

  switch (event.type) {
    case "session.start":
    case "session.resume":
      // a resumed session restarts the wall clock: the supervisor is only responsible for the
      // stretch it is actually watching, not for hours the session spent parked
      state.startedAt = event.ts;
      break;
    case "session.end":
      state.ended = true;
      break;
    case "turn.end":
      state.turns += 1;
      break;
    case "tool.call":
      state.toolCalls += 1;
      break;
    case "tool.result":
      if (!event.ok) state.toolErrors += 1;
      break;
    case "file.changed":
      state.filesChanged += 1;
      break;
    case "model.response":
      state.usage.input += event.usage.input;
      state.usage.output += event.usage.output;
      if (opts.pricing !== undefined) {
        state.usd +=
          (event.usage.input * opts.pricing.inputUsdPerMTok) / 1e6 +
          (event.usage.output * opts.pricing.outputUsdPerMTok) / 1e6;
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
