import type { EventOf, HarnessEvent, Intervention, InterventionCost, Signal } from "./events.js";
import type { ContextManifestBlock } from "./context-manifest.js";
import type { InstructionContext } from "./messages.js";
import { contentHash } from "./session-store.js";

/**
 * R17e. What was actually put in front of the model, and why — the fold behind `/why`.
 *
 * The whole value of this file is the word *actually*. A supervisor records a decision BEFORE it
 * applies it (PLAN §4.4), `steer` only queues, and a queued steer that never reached a turn
 * boundary is reported as undelivered at session end (see `undeliveredSteerMessage`). So the only
 * evidence that guidance entered the conversation is the `steer` event itself, which core writes
 * in the same breath as it pushes the message onto `messages` — immediately before the
 * `turn.start` of the turn that carries it (agent.ts). That adjacency is the attribution rule
 * here: guidance belongs to the turn whose `turn.start` follows it, never to the turn it was
 * decided during.
 *
 * Everything else is read from the request that was actually built: `context.manifest` is
 * measured from the outgoing `ModelRequest`, so the memory index and any memory tool results in
 * this explanation are the bytes the provider received, not a re-read of a file that may have
 * moved on since.
 *
 * The fold is pure and local: no provider call, no filesystem, no configuration.
 */

/** Wording core uses when the session ended before a queued steer reached a turn boundary. */
export function undeliveredSteerMessage(source: string, message: string): string {
  return `steer from ${source} not delivered (session ended): ${message}`;
}

const UNDELIVERED = /^steer from (user|supervisor|hook) not delivered \(session ended\): ([\s\S]*)$/;

/** A supervisor decision, folded together with what applying it actually did. */
export interface GuidanceDecision {
  seq: number;
  id?: string;
  intervention: Intervention;
  /** The signals the policy acted on, as the observer recorded them. Empty on pre-R17e logs. */
  noticed: Signal[];
  outcome?: {
    outcome: EventOf<"supervisor.outcome">["outcome"];
    detail?: string;
    cost: InterventionCost;
  };
}

/** One piece of text that actually entered the conversation for a turn. */
export interface InjectedGuidance {
  seq: number;
  source: "user" | "supervisor" | "hook";
  message: string;
  bytes: number;
  context?: InstructionContext;
  /** The recorded decision whose injected digest matches this text, when one does. */
  decision?: GuidanceDecision;
}

/** Prompt material the harness added that the user never typed, measured from the sent request. */
export interface TurnPromptContext {
  turn: number;
  requestHash: string;
  /** System-side blocks: the memory index, the skills catalogue, the repository map, and so on. */
  automatic: ContextManifestBlock[];
  /** Tool results from the retrieval tools the caller named, carried in this request's history. */
  recalls: ContextManifestBlock[];
}

export interface TurnExplanation {
  sessionId: string;
  /** The turn the guidance below was injected into; null before any turn has started. */
  turn: number | null;
  /** Whether that turn has finished. An explanation is valid either way. */
  complete: boolean;
  /** Delivered into that turn's request, in order. This is the "actually injected" set. */
  injected: InjectedGuidance[];
  /** Decisions recorded in the window that produced this turn which injected no text. */
  otherDecisions: GuidanceDecision[];
  /** Queued after that turn started: not part of it. */
  pending: InjectedGuidance[];
  /** Queued text the log says was never delivered at all. */
  undelivered: Array<{ seq: number; source: string; message: string }>;
  context: TurnPromptContext | null;
}

export interface ExplainOptions {
  /**
   * Tool names whose results count as a memory recall in the manifest. Supplied by the caller so
   * core does not hardcode another package's tool names.
   */
  recallTools?: ReadonlySet<string>;
}

const LIMITS = {
  /** Steers per turn, decisions retained, and undelivered notices: bounded, oldest dropped. */
  batch: 64,
  decisions: 64,
  undelivered: 32,
} as const;

function bounded<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * Incremental, bounded accumulator over one session's events.
 *
 * Stateful rather than a fold over a retained event array because the TUI must not keep every
 * event of a long session alive to answer `/why`, and because the reset points are lifecycle
 * events: `session.start`, `session.resume` and `session.fork` each begin a run whose guidance is
 * its own. A resumed or forked run therefore cannot show the previous run's turn as current.
 */
export class GuidanceLog {
  private sessionId = "";
  private turn: number | null = null;
  private complete = false;
  /** Steers seen since the last `turn.start`; they belong to the turn that starts next. */
  private queued: InjectedGuidance[] = [];
  private injected: InjectedGuidance[] = [];
  private decisions: GuidanceDecision[] = [];
  /** Decisions recorded since the previous turn began, for the "what else did it do" section. */
  private windowStart = 0;
  private previousWindowStart = 0;
  private byId = new Map<string, GuidanceDecision>();
  /** Injected-text digest → decisions awaiting their `steer`, in the order they were queued. */
  private byDigest = new Map<string, GuidanceDecision[]>();
  private undelivered: Array<{ seq: number; source: string; message: string }> = [];
  private manifest: EventOf<"context.manifest"> | null = null;

  reset(): void {
    this.sessionId = "";
    this.turn = null;
    this.complete = false;
    this.queued = [];
    this.injected = [];
    this.decisions = [];
    this.windowStart = 0;
    this.previousWindowStart = 0;
    this.byId = new Map();
    this.byDigest = new Map();
    this.undelivered = [];
    this.manifest = null;
  }

  push(event: HarnessEvent): void {
    if (event.type === "session.start" || event.type === "session.resume" || event.type === "session.fork") {
      this.reset();
      this.sessionId = event.sessionId;
      return;
    }
    if (this.sessionId === "") this.sessionId = event.sessionId;
    switch (event.type) {
      case "supervisor.intervention": {
        const decision: GuidanceDecision = {
          seq: event.seq,
          ...(event.id === undefined ? {} : { id: event.id }),
          intervention: event.intervention,
          noticed: event.noticed ?? [],
        };
        this.decisions = bounded([...this.decisions, decision], LIMITS.decisions);
        if (event.id !== undefined) this.byId.set(event.id, decision);
        return;
      }
      case "supervisor.outcome": {
        const decision = this.byId.get(event.id);
        if (decision === undefined) return;
        decision.outcome = {
          outcome: event.outcome,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          cost: event.cost,
        };
        // Only a decision that claims to have queued text can claim a later steer.
        if (event.outcome === "queued" && event.cost.injected !== undefined) {
          const waiting = this.byDigest.get(event.cost.injected.hash) ?? [];
          waiting.push(decision);
          this.byDigest.set(event.cost.injected.hash, waiting);
        }
        return;
      }
      case "steer": {
        const entry: InjectedGuidance = {
          seq: event.seq,
          source: event.source,
          message: event.message,
          bytes: Buffer.byteLength(event.message, "utf8"),
          ...(event.context === undefined ? {} : { context: event.context }),
        };
        // Attribution is claimed only by a SUPERVISOR steer: a user message with identical text
        // must not be able to wear the supervisor's reasoning.
        if (event.source === "supervisor") {
          const waiting = this.byDigest.get(contentHash(event.message));
          const decision = waiting?.shift();
          if (waiting?.length === 0) this.byDigest.delete(contentHash(event.message));
          if (decision !== undefined) entry.decision = decision;
        }
        this.queued = bounded([...this.queued, entry], LIMITS.batch);
        return;
      }
      case "turn.start": {
        this.turn = event.n;
        this.complete = false;
        this.injected = this.queued;
        this.queued = [];
        this.previousWindowStart = this.windowStart;
        this.windowStart = event.seq;
        this.manifest = null;
        return;
      }
      case "turn.end": {
        if (this.turn === event.n) this.complete = true;
        return;
      }
      case "context.manifest": {
        if (this.turn === event.turn) this.manifest = event;
        return;
      }
      case "error": {
        const match = UNDELIVERED.exec(event.message);
        if (match?.[1] === undefined || match[2] === undefined) return;
        this.undelivered = bounded(
          [...this.undelivered, { seq: event.seq, source: match[1], message: match[2] }],
          LIMITS.undelivered,
        );
        return;
      }
      default:
        return;
    }
  }

  /** The last turn's explanation, or null when this run has not started a turn yet. */
  explainLast(opts: ExplainOptions = {}): TurnExplanation | null {
    if (this.turn === null) return null;
    const recallTools = opts.recallTools ?? new Set<string>();
    const manifest = this.manifest;
    const claimed = new Set(this.injected.flatMap((entry) => entry.decision === undefined ? [] : [entry.decision]));
    return {
      sessionId: this.sessionId,
      turn: this.turn,
      complete: this.complete,
      injected: this.injected,
      // The window that produced this turn: everything the observer decided while the previous
      // turn ran. A decision that injected text is already reported above, not twice.
      otherDecisions: this.decisions.filter(
        (decision) => decision.seq >= this.previousWindowStart && !claimed.has(decision),
      ),
      pending: this.queued,
      undelivered: this.undelivered,
      context: manifest === null ? null : {
        turn: manifest.turn,
        requestHash: manifest.requestHash,
        automatic: manifest.blocks.filter((block) => block.source !== "history" && block.source !== "tool_result"),
        recalls: manifest.blocks.filter(
          (block) => block.source === "tool_result" && recallTools.has(block.origin.split(":")[0] ?? ""),
        ),
      },
    };
  }
}
