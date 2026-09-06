import type { CommandOutcome, HarnessEvent, PlanItem } from "@agentkitai/agentrig-core";

export interface CommandCheck { command: string; exitCode: number }
/** Exact bounded grammar, not a shell parser or a semantic interpretation of arbitrary prose. */
export function parseCommandCheck(accept: string | undefined): CommandCheck | undefined {
  if (accept === undefined || accept.length > 1024 || /[\r\n\0]/.test(accept)) return undefined;
  const match = /^(\S(?:.*\S)?) exits (0|[1-9]\d{0,8})$/.exec(accept);
  return match === null ? undefined : { command: match[1]!, exitCode: Number(match[2]) };
}

export interface PlanEvidenceAttempt {
  callSeq: number;
  resultSeq?: number;
  /** Unknown includes proposed calls, legacy output, interruption and absent/corrupt receipts. */
  observation: "exit-match" | "exit-mismatch" | "unknown";
  reason: string;
  outcome?: CommandOutcome;
}
export interface PlanItemEvidence {
  id: string;
  text: string;
  accept?: string;
  /** Observation only: even exit-match never establishes semantic acceptance or completion. */
  verification: "unverified";
  reason: string;
  attempts: PlanEvidenceAttempt[];
  omittedAttempts: number;
}
export interface PlanEvidenceLedger {
  items: PlanItemEvidence[];
  /** A bounded view; raw events remain the authoritative history. Never claim full coverage here. */
  incomplete: boolean;
  omittedItems: number;
}

const MAX_ITEMS = 100;
const MAX_ATTEMPTS = 16;
const MAX_PENDING = 400;
type Binding = { item: PlanItemEvidence; attempt: PlanEvidenceAttempt; check: CommandCheck };
type Pending = { id: string; command?: string; cwd?: string; bindings: Binding[] };
type Internal = { sessionId?: string; cwd?: string; pending: Map<number, Pending>; keys: Map<PlanItemEvidence, string> };
const internals = new WeakMap<PlanEvidenceLedger, Internal>();

export function initialPlanEvidence(): PlanEvidenceLedger {
  return { items: [], incomplete: false, omittedItems: 0 };
}

function finishUnknown(pending: Pending, reason: string): void {
  for (const { attempt } of pending.bindings) {
    attempt.observation = "unknown";
    attempt.reason = reason;
  }
}

/** Fold canonical events only; output text and model-supplied acceptance claims are never oracles. */
export function reducePlanEvidence(ledger: PlanEvidenceLedger, event: HarnessEvent): void {
  let state = internals.get(ledger);
  if (state === undefined) {
    state = { pending: new Map(), keys: new Map() };
    internals.set(ledger, state);
  }
  if (state.sessionId === undefined) state.sessionId = event.sessionId;
  if (state.sessionId !== event.sessionId) return;
  if (event.type === "session.start" || event.type === "session.resume") state.cwd = event.cwd;
  if (["turn.start", "turn.end", "session.start", "session.resume", "session.end"].includes(event.type)) {
    for (const pending of state.pending.values()) finishUnknown(pending, "no correlated completion before boundary");
    state.pending.clear();
  }
  if (event.type === "plan.updated") {
    const counts = new Map<string, number>();
    for (const item of event.items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    const old = new Map([...state.keys].map(([item, key]) => [key, item]));
    state.keys.clear();
    ledger.omittedItems = Math.max(0, event.items.length - MAX_ITEMS);
    if (ledger.omittedItems > 0) ledger.incomplete = true;
    ledger.items = event.items.slice(0, MAX_ITEMS).map((item: PlanItem) => {
      // Status updates retain observations, but altered text/scope/check or remove+re-add do not.
      const bounded = item.id.length <= 256 && item.text.length <= 2048 &&
        (item.scope?.length ?? 0) <= 64 && (item.scope ?? []).every(path => path.length <= 4096);
      const unique = counts.get(item.id) === 1;
      const key = bounded && unique ? JSON.stringify([item.id, item.text, item.accept, item.scope]) : undefined;
      const previous = key === undefined ? undefined : old.get(key);
      const record: PlanItemEvidence = previous ?? {
        id: item.id.slice(0, 256), text: item.text.slice(0, 2048),
        ...(item.accept === undefined ? {} : { accept: item.accept }),
        verification: "unverified",
        reason: !bounded ? "item exceeds evidence bounds" : !unique ? "ambiguous duplicate item id" :
          parseCommandCheck(item.accept) === undefined ? "undeclared or unsupported check" : "no matching command attempt",
        attempts: [], omittedAttempts: 0,
      };
      if (!bounded) ledger.incomplete = true;
      if (key !== undefined) state.keys.set(record, key);
      return record;
    });
    return;
  }
  if (event.type === "tool.call") {
    const input = event.input;
    const command = typeof input === "object" && input !== null && !Array.isArray(input) &&
      typeof (input as { command?: unknown }).command === "string" ? (input as { command: string }).command : undefined;
    const bindings: Binding[] = [];
    for (const item of ledger.items) {
      if (!state.keys.has(item)) continue;
      const check = parseCommandCheck(item.accept);
      if (check === undefined || check.command !== command) continue;
      const attempt: PlanEvidenceAttempt = { callSeq: event.seq, observation: "unknown", reason: "awaiting canonical foreground completion" };
      item.attempts.push(attempt);
      if (item.attempts.length > MAX_ATTEMPTS) {
        item.attempts.shift(); item.omittedAttempts++; ledger.incomplete = true;
      }
      item.reason = "candidate command observations only; semantic acceptance remains unverified";
      bindings.push({ item, attempt, check });
    }
    if (bindings.length === 0) return;
    state.pending.set(event.seq, { id: event.id, ...(command === undefined ? {} : { command }),
      ...(state.cwd === undefined ? {} : { cwd: state.cwd }), bindings });
    if (state.pending.size > MAX_PENDING) {
      const oldest = state.pending.keys().next().value!;
      finishUnknown(state.pending.get(oldest)!, "pending correlation bound exceeded");
      state.pending.delete(oldest); ledger.incomplete = true;
    }
    return;
  }
  if (event.type !== "tool.result" || event.toolCallSeq === undefined) return;
  const pending = state.pending.get(event.toolCallSeq);
  if (pending === undefined || pending.id !== event.id) return;
  state.pending.delete(event.toolCallSeq);
  for (const { item, attempt, check } of pending.bindings) {
    if (!ledger.items.includes(item)) continue;
    attempt.resultSeq = event.seq;
    const outcome = event.commandOutcome;
    if (outcome === undefined || outcome.command !== pending.command || outcome.cwd !== pending.cwd ||
      outcome.timedOut || outcome.aborted || outcome.exitCode === null) {
      attempt.reason = "missing, mismatched or interrupted foreground outcome";
      if (outcome !== undefined) attempt.outcome = { ...outcome };
    } else if (event.ok !== (outcome.exitCode === 0)) {
      attempt.reason = "result and foreground outcome disagree";
    } else {
      attempt.outcome = { ...outcome };
      attempt.observation = outcome.exitCode === check.exitCode ? "exit-match" : "exit-mismatch";
      attempt.reason = "observed command exit only; not semantic proof";
    }
  }
}
