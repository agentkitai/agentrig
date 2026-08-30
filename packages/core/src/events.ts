import { z } from "zod";

/**
 * The event spine. Every session is an append-only log of these events.
 * The CLI renders it, the supervisor watches it, the dream reads it, resume replays it.
 *
 * Rules:
 * - Add fields, never repurpose them. Consumers may run against old logs.
 * - Anything a detector needs to compare cheaply is a hash (inputHash, contentHash).
 * - `seq`, `sessionId`, and `ts` are stamped by the SessionStore, not by emitters.
 */

export const PermissionClass = z.enum(["read", "write", "exec", "network"]);
export type PermissionClass = z.infer<typeof PermissionClass>;

export const Decision = z.enum(["allow", "deny", "ask"]);
export type Decision = z.infer<typeof Decision>;

export const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const PermissionRequest = z.object({
  tool: z.string(),
  input: z.unknown(),
  class: PermissionClass,
  cwd: z.string(),
  /** Filesystem paths the call touches, as declared by the tool's `paths()`; absent when the tool declares none. */
  paths: z.array(z.string()).optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PlanItem = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  /**
   * Paths or path prefixes this item is allowed to touch. The supervisor's `drift` detector
   * (PLAN §4.1) needs a declared scope to compare `file.changed` against; with no scope on any
   * item, drift cannot fire. A trailing `/` (or a bare directory) matches everything beneath it.
   */
  scope: z.array(z.string()).optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

/** Emitted by the supervisor package; core only knows the shape. */
export const Signal = z.object({
  type: z.enum(["loop", "stall", "error_burst", "drift", "budget", "test_regression"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  window: z.tuple([z.number().int(), z.number().int()]), // [fromSeq, toSeq]
});
export type Signal = z.infer<typeof Signal>;

export const Intervention = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inject_guidance"), message: z.string() }),
  z.object({ type: z.literal("force_replan") }),
  z.object({ type: z.literal("run_grader"), rubric: z.string() }),
  /** M6: hand the trajectory + attempts ledger to a reviewer and steer its guidance. */
  z.object({ type: z.literal("run_reviewer"), reason: z.string() }),
  z.object({ type: z.literal("checkpoint_rollback"), toSeq: z.number().int() }),
  z.object({ type: z.literal("escalate"), question: z.string() }),
  z.object({ type: z.literal("abort"), reason: z.string() }),
]);
export type Intervention = z.infer<typeof Intervention>;

/**
 * The only payloads an out-of-band observer may append through `SessionControl.record`.
 * Validated there: `serializeEvent` is a bare `JSON.stringify`, so an unvalidated payload (a
 * detector emitting `confidence: 1.4`, or `NaN`, which stringifies to `null`) would write a line
 * that `SessionStore.read` then refuses — permanently breaking `sessions show`, resume, and
 * `memory ingest` for that session, with no repair path because `raw/` is immutable.
 */
export const SupervisorRecord = z.discriminatedUnion("type", [
  z.object({ type: z.literal("supervisor.signal"), signal: Signal }),
  z.object({ type: z.literal("supervisor.intervention"), intervention: Intervention }),
]);
export type SupervisorRecord = z.infer<typeof SupervisorRecord>;

/** The payload an emitter produces. The store stamps seq/sessionId/ts. */
export const EventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.start"), task: z.string(), cwd: z.string(), provider: z.string(), model: z.string() }),
  z.object({ type: z.literal("session.resume"), task: z.string(), cwd: z.string(), provider: z.string(), model: z.string() }),
  z.object({ type: z.literal("session.end"), reason: z.enum(["done", "aborted", "error", "budget"]) }),
  z.object({ type: z.literal("turn.start"), n: z.number().int() }),
  z.object({ type: z.literal("turn.end"), n: z.number().int() }),
  z.object({ type: z.literal("model.request"), tokensIn: z.number().int() }),
  z.object({ type: z.literal("model.delta"), text: z.string() }),
  z.object({ type: z.literal("model.response"), usage: Usage, stop: z.string() }),
  z.object({ type: z.literal("tool.call"), id: z.string(), name: z.string(), input: z.unknown(), inputHash: z.string() }),
  z.object({ type: z.literal("tool.result"), id: z.string(), ok: z.boolean(), display: z.string(), durationMs: z.number().int() }),
  /**
   * M7: a `post_tool` hook rewrote or appended to what the MODEL consumed. `tool.result` keeps
   * what the tool actually returned, so without this the log and the model's conversation could
   * diverge silently — and a hook could steer the model with text no observer ever saw.
   */
  z.object({ type: z.literal("tool.result.patched"), id: z.string(), by: z.string(), display: z.string() }),
  z.object({ type: z.literal("tool.denied"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("file.changed"), path: z.string(), op: z.enum(["create", "edit", "delete"]), contentHash: z.string() }),
  z.object({ type: z.literal("permission.request"), req: PermissionRequest }),
  z.object({ type: z.literal("permission.decision"), d: Decision }),
  z.object({ type: z.literal("context.compact"), before: z.number().int(), after: z.number().int() }),
  z.object({ type: z.literal("plan.updated"), items: z.array(PlanItem) }),
  z.object({ type: z.literal("subagent.spawn"), id: z.string(), task: z.string() }),
  z.object({
    type: z.literal("subagent.end"),
    id: z.string(),
    /** M7: how the child finished. Optional so logs written before this still parse. */
    reason: z.enum(["done", "aborted", "error", "budget"]).optional(),
  }),
  z.object({ type: z.literal("steer"), source: z.enum(["user", "supervisor", "hook"]), message: z.string() }),
  z.object({ type: z.literal("memory.note"), scope: z.enum(["project", "global"]), path: z.string() }),
  z.object({ type: z.literal("supervisor.signal"), signal: Signal }),
  z.object({ type: z.literal("supervisor.intervention"), intervention: Intervention }),
  z.object({ type: z.literal("error"), message: z.string(), fatal: z.boolean() }),
]);
export type EventPayload = z.infer<typeof EventPayload>;

const Envelope = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
  ts: z.number().int(),
});

/** A stored event: payload + envelope. This is the on-disk JSONL line. */
export const HarnessEvent = z.intersection(Envelope, EventPayload);
export type HarnessEvent = z.infer<typeof HarnessEvent>;

export type EventType = EventPayload["type"];
export type EventOf<T extends EventType> = Extract<HarnessEvent, { type: T }>;

/** Parse one JSONL line. Throws on schema violation — a corrupt log should fail loudly, not silently skip. */
export function parseEvent(line: string): HarnessEvent {
  return HarnessEvent.parse(JSON.parse(line));
}

export function serializeEvent(event: HarnessEvent): string {
  return JSON.stringify(event);
}
