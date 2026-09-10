import { z } from "zod";
import { FileDiff } from "./file-diff-types.js";
import { QuestionSchema, QuestionReplySchema } from "./questions.js";
import { AdvisoryPromptContextSchema, MessageSchema, InstructionContextSchema } from "./messages.js";
import { DiagnosticsSchema, InternalToolSchema } from "./diagnostics-types.js";
import { SandboxMode } from "./sandbox.js";
import { ShellOperationSchema } from "./shell-operation.js";
import { PermissionClass, Decision } from "./permission-types.js";
import { PermissionGrantEventSchema } from "./permission-grants.js";
import { PermissionDecisionSourceSchema } from "./permission-attribution.js";
import { ProviderSelectionInfoSchema } from "./provider-selection.js";
export { PermissionClass, Decision } from "./permission-types.js";

/**
 * The event spine. Every session is an append-only log of these events.
 * The CLI renders it, the supervisor watches it, the dream reads it, resume replays it.
 *
 * Rules:
 * - Add fields, never repurpose them. Consumers may run against old logs.
 * - Anything a detector needs to compare cheaply is a hash (inputHash, contentHash).
 * - `seq`, `sessionId`, and `ts` are stamped by the SessionStore, not by emitters.
 */

/**
 * The four counts are DISJOINT: `input` is the uncached input tokens only, excluding both
 * `cacheRead` and `cacheWrite`. Anthropic reports it that way natively; both OpenAI adapters
 * subtract `cached_tokens` out of the inclusive count the API returns. This is a contract —
 * a consumer that wants "everything the model saw" sums the fields, and a provider that let a
 * cached prefix stay inside `input` would make that sum double-count.
 */
export const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const AuxiliaryReportSchema = z.object({
  operation: z.enum(["ingest", "dream", "reviewer", "grader"]),
  outcome: z.enum(["completed", "failed", "aborted", "timeout", "limit"]),
  durationMs: z.number().finite().nonnegative(),
  calls: z.array(z.object({
    operation: z.string(), provider: z.string(), model: z.string().optional(),
    /** Provisional calls have no terminal outcome yet; absent on legacy records. */
    state: z.enum(["running", "settled"]).optional(),
    outcome: z.enum(["completed", "failed", "aborted", "timeout", "limit"]),
    durationMs: z.number().finite().nonnegative(), usage: Usage.optional(), usageComplete: z.boolean(),
  })),
  reportedUsage: Usage, unknownUsageCalls: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
  localCommitState: z.enum(["not-started", "may-be-partial", "completed"]).optional(),
});
/** Replace cumulative snapshots by id, never sum them. A non-final last snapshot means
 * completion/total usage is unknown; auxiliary consumption never joins main model usage. */
export const AuxiliaryUsageRecord = z.object({
  type: z.literal("auxiliary.usage"), id: z.string().min(1).max(128),
  report: AuxiliaryReportSchema, final: z.boolean(),
});

export const PermissionRequest = z.object({
  tool: z.string(),
  input: z.unknown(),
  class: PermissionClass,
  cwd: z.string(),
  /** Filesystem paths the call touches, as declared by the tool's `paths()`; absent when the tool declares none. */
  paths: z.array(z.string()).optional(),
  /** Derived by trusted tool wiring from final validated input, never copied from model metadata. */
  operation: ShellOperationSchema.optional(),
  /** Builtin proposal from final validated input; no filesystem observation or authority. */
  fileDiff: FileDiff.optional(),
  /**
   * M7: who is asking, when it is not the session the user is watching — a subagent routes its
   * asks through its parent's prompt, and answering "allow" for a child you cannot see is a
   * different decision from answering it for yourself. Absent means the session itself.
   */
  origin: z.string().optional(),
  /** Runtime child provenance retained when a separate-consent origin replaces origin. */
  sourceOrigin: z.string().optional(),
  expansionSurface: z.enum(["exec", "network", "write-outside-cwd"]).optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PlanItem = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  /** Observable check declared by the plan author, not verified evidence or a completion gate. */
  accept: z.string().min(1).max(1024).refine(value => value.trim().length > 0, "accept must not be blank").optional(),
  /**
   * Paths or path prefixes this item is allowed to touch. The supervisor's `drift` detector
   * (PLAN §4.1) needs a declared scope to compare `file.changed` against; with no scope on any
   * item, drift cannot fire. A trailing `/` (or a bare directory) matches everything beneath it.
   */
  scope: z.array(z.string()).optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

/** Observed foreground shell outcome, not proof that its command checks the intended behavior. */
export const CommandOutcome = z.object({
  command: z.string().min(1).max(1024),
  cwd: z.string().min(1).max(4096),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
});
export type CommandOutcome = z.infer<typeof CommandOutcome>;

/** Emitted by the supervisor package; core only knows the shape. */
export const Signal = z.object({
  type: z.enum(["loop", "stall", "error_burst", "drift", "budget", "test_regression", "injection"]),
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
 * The rung an outcome reports on. Kept as its own enum rather than derived from `Intervention`, so
 * a new rung is a deliberate edit in both places; `events.test.ts` pins that the two agree.
 */
export const InterventionType = z.enum([
  "inject_guidance", "force_replan", "run_grader", "run_reviewer", "checkpoint_rollback", "escalate", "abort",
]);
export type InterventionType = z.infer<typeof InterventionType>;

/**
 * R17e. What one intervention actually cost, in the only terms the harness can honestly state.
 *
 * `modelCalls: "none"` is a fact about the heuristic rungs — a detector and the ladder are local
 * computation, so there is nothing to bill. `"auxiliary"` means an LLM-backed rung ran, and the
 * consumption lives in the `auxiliary.usage` record named by `auxiliaryId`: reported usage there
 * may be incomplete or absent, and unknown must stay unknown, so it is deliberately NOT copied or
 * summed here. `injected` measures the text queued for the model prompt — bytes on the wire and a
 * digest of them, never billed tokens, which only the provider's own usage can establish.
 */
export const InterventionCost = z.object({
  modelCalls: z.enum(["none", "auxiliary"]),
  auxiliaryId: z.string().min(1).max(128).optional(),
  injected: z.object({
    bytes: z.number().int().nonnegative(),
    /** First 16 hex characters of SHA-256 over the exact injected UTF-8 text (`contentHash`). */
    hash: z.string().regex(/^[a-f0-9]{16}$/),
  }).optional(),
});
export type InterventionCost = z.infer<typeof InterventionCost>;

const SupervisorSignalEvent = z.object({ type: z.literal("supervisor.signal"), signal: Signal });

/**
 * A DECISION, not proof that anything happened: the observer records it before it applies the
 * rung (PLAN §4.4). `supervisor.outcome` reports what applying it actually did.
 *
 * `noticed` carries the signal(s) the policy acted on, so one transcript line can say what was
 * noticed and what was done without a reader having to correlate two events across an await
 * boundary. It duplicates the adjacent `supervisor.signal` records on purpose and is bounded.
 */
const SupervisorInterventionEvent = z.object({
  type: z.literal("supervisor.intervention"),
  intervention: Intervention,
  /** Correlates this decision with its `supervisor.outcome`. Absent on logs written before R17e. */
  id: z.string().min(1).max(128).optional(),
  noticed: z.array(Signal).max(16).optional(),
});

/**
 * R17e. What applying a recorded intervention did, so "recorded" is never read as "applied".
 *
 * - `queued`: text was handed to `steer` and lands at the next turn boundary. The `steer` event is
 *   the only proof it was delivered; a session that ends first records a non-delivery `error`.
 * - `applied`: the effect happened synchronously (a plan gate went up, an abort was requested, a
 *   human was asked and answered).
 * - `no-action`: the rung ran and produced nothing to inject (an empty reviewer, a passing grade).
 * - `unavailable`: the harness cannot perform this rung (no escalation handler, no reviewer).
 * - `failed`: applying it threw, timed out, or was cancelled.
 */
const SupervisorOutcomeEvent = z.object({
  type: z.literal("supervisor.outcome"),
  id: z.string().min(1).max(128),
  intervention: InterventionType,
  outcome: z.enum(["queued", "applied", "no-action", "unavailable", "failed"]),
  detail: z.string().max(4096).optional(),
  cost: InterventionCost,
});

/**
 * The only payloads an out-of-band observer may append through `SessionControl.record`.
 * Validated there: `serializeEvent` is a bare `JSON.stringify`, so an unvalidated payload (a
 * detector emitting `confidence: 1.4`, or `NaN`, which stringifies to `null`) would write a line
 * that `SessionStore.read` then refuses — permanently breaking `sessions show`, resume, and
 * `memory ingest` for that session, with no repair path because `raw/` is immutable.
 */
export const SupervisorRecord = z.discriminatedUnion("type", [
  AuxiliaryUsageRecord,
  SupervisorSignalEvent,
  SupervisorInterventionEvent,
  SupervisorOutcomeEvent,
]);
export type SupervisorRecord = z.infer<typeof SupervisorRecord>;

/**
 * The only event kinds a TOOL may emit through `ToolContext.emit`. Everything else — permission
 * decisions and requests, session lifecycle (`session.start/resume/end`), supervisor records,
 * turn and model events, `tool.*` — is the loop's or the supervisor's to write, never a tool's.
 *
 * A tool's output is external / tool-output trust (a shell command, a fetched page, an MCP server's
 * reply). Without this gate a buggy or malicious in-process tool — or a custom tool that forwards
 * untrusted content into `ctx.emit` — can append a forged `permission.decision: allow` or a
 * premature `session.end` to the append-only log (issue #63). (The built-in MCP adapter does not
 * call `ctx.emit` at all, so a server behind it cannot reach the log this way; the vector is the
 * tool code itself.) It grants no capability: the permission engine adjudicates every real call
 * from the request, not the log. But the log is what the supervisor's state fold, `sessions show`,
 * trajectory export, and evidence collection read as ground truth, so a forgeable audit trail is
 * its own harm — and a malformed allowed-type event that the store cannot re-parse would corrupt
 * the whole session log, which is why the loop validates SHAPE as well as type at that seam. This is
 * the tool-side analogue of `record()`'s validation of supervisor writes: the two seams together are
 * why "an observer cannot forge a `tool.call` or a `session.end`" is actually true.
 *
 * Kept as a plain string set (not derived from the schema) so adding it needs a deliberate edit:
 * a new event type is NOT tool-emittable until someone adds it here on purpose.
 */
export const TOOL_EMITTABLE_EVENTS: ReadonlySet<string> = new Set([
  "plan.updated",
  "file.changed",
  "subagent.spawn",
  "subagent.end",
  "skill.used",
]);

/**
 * Of the emittable types, the ones that carry authority beyond information, keyed to the ONE tool
 * allowed to emit each (issue #67). `plan.updated` releases the supervisor's force_replan gate and
 * defines the scope the drift detector enforces; `subagent.spawn`/`subagent.end` assert that a
 * child session exists. From any other tool those are forgeries — a way to shrug off the one
 * intervention PLAN §4.2 says cannot be ignored, or to plant phantom children in the trace — so
 * the loop drops them. `file.changed` is deliberately absent: many tools legitimately write files.
 * (Its residual — forged progress laundering the loop/stall detectors — is a detector-side
 * problem, tracked separately.)
 *
 * Values are plain strings rather than imports of the tool-name constants: events.ts must not
 * depend on tool modules, and a mapping change should be a deliberate, visible edit here — the
 * gate tests pin both the contents and the enforcement.
 */
export const TOOL_EMIT_SOURCES: ReadonlyMap<string, string> = new Map([
  ["plan.updated", "update_plan"],
  ["subagent.spawn", "subagent"],
  ["subagent.end", "subagent"],
  // R9 reads skill.used as the record of which skills actually got activated; a forged one from
  // another tool would salt that measurement, so it is held to the skill tool.
  ["skill.used", "skill"],
]);

/** The payload an emitter produces. The store stamps seq/sessionId/ts. */
export const EventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output.validated"), digest: z.string().regex(/^[a-f0-9]{64}$/), mode: z.enum(["prompted", "native"]),
    attempt: z.enum(["initial", "repair"]), valid: z.boolean(), category: z.enum(["valid", "json", "schema", "bound", "tool", "stop"]) }),
  z.object({ type: z.literal("question.asked"), id: z.string().uuid(), toolUseId: z.string(), question: QuestionSchema }),
  z.object({ type: z.literal("question.answered"), id: z.string().uuid(), toolUseId: z.string(),
    outcome: z.enum(["answered", "unavailable", "timeout", "cancelled"]), reply: QuestionReplySchema.optional() }),
  z.object({
    type: z.literal("run.scheduled"),
    source: z.literal("heartbeat").optional(),
    entryId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
    minute: z.number().int().nonnegative().safe(),
  }),
  z.object({
    type: z.literal("provider.switched"),
    from: ProviderSelectionInfoSchema.optional(),
    to: ProviderSelectionInfoSchema,
    turn: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("session.start"),
    task: z.string(),
    advisoryContext: AdvisoryPromptContextSchema.optional(),
    /** Attachment-only input has no synthetic empty user text message. */
    inputAttachments: z.literal(true).optional(),
    context: InstructionContextSchema.optional(),
    cwd: z.string(),
    provider: z.string(),
    model: z.string(),
    /**
     * The session that spawned this one (#104): a subagent's own log names its parent, so a
     * `subagent.spawn` record in some other log claiming this session can be checked against the
     * session's own word. Absent for a top-level session and for logs written before this field.
     */
    parent: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  }),
  z.object({
    type: z.literal("session.fork"),
    parent: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    atSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("session.resume"),
    maintenance: z.literal("compact").optional(),
    task: z.string(),
    advisoryContext: AdvisoryPromptContextSchema.optional(),
    context: InstructionContextSchema.optional(),
    cwd: z.string(),
    provider: z.string(),
    model: z.string(),
    /** Cumulative completed turns, additive so pre-R1.5c logs remain readable. */
    turns: z.number().int().nonnegative().optional(),
  }),
  /** Runtime-only: model work has stopped; owned maintenance/cleanup is not yet settled. */
  z.object({ type: z.literal("session.finishing"), reason: z.enum(["done", "aborted", "error", "budget"]) }),
  z.object({ type: z.literal("session.end"), reason: z.enum(["done", "aborted", "error", "budget"]) }),
  /** Trusted evaluation coordinator receipt, not tool/observer-emittable or a model grade. */
  z.object({ type: z.literal("eval.result"), task: z.string().min(1).max(64),
    sourceSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), runId: z.string().uuid(), profile: z.string().min(1).max(128),
    outcome: z.enum(["PASS", "FAIL", "BLOCKED", "SKIP"]), baselineOutcome: z.enum(["PASS", "FAIL", "BLOCKED", "SKIP"]),
    reportedTokens: z.number().int().nonnegative(), usageComplete: z.boolean(),
    totalCostUsd: z.number().finite().nonnegative().nullable(), advisoryPass: z.boolean().nullable() }),
  z.object({ type: z.literal("turn.start"), n: z.number().int() }),
  z.object({ type: z.literal("turn.continued"), n: z.number().int().positive(), from: z.number().int().positive(),
    attempt: z.number().int().min(1).max(2), maxAttempts: z.literal(2), reason: z.literal("max_tokens") }),
  z.object({ type: z.literal("turn.end"), n: z.number().int() }),
  z.object({ type: z.literal("model.request"), tokensIn: z.number().int() }),
  z.object({ type: z.literal("budget.cap"), reason: z.enum(["exhausted", "uncertain", "unavailable", "unsupported"]), segment: z.string().min(1).max(256) }),
  z.object({ type: z.literal("model.delta"), text: z.string() }),
  z.object({ type: z.literal("model.response"), usage: Usage, stop: z.string(),
    /** E2: missing on legacy logs means unknown, not a provider-reported zero. Retried,
     * synthesized, unclosed or errored calls cannot establish complete total consumption. */
    usageComplete: z.boolean().optional(),
  }),
  /** Authoritative conversation boundary persisted after the in-memory message is appended. */
  z.object({ type: z.literal("message.append"), message: MessageSchema }),
  z.object({ type: z.literal("context.delegation"), principal: z.string().max(256).regex(/^hook:.+/),
    action: z.enum(["delegated", "revoked"]), delegation: z.string().max(64) }),
  /**
   * A transient provider failure was retried before anything streamed. Informational, but
   * load-bearing for diagnosis: two real sessions died on overload errors and the logs said
   * nothing about the provider struggling until the fatal line.
   */
  z.object({
    type: z.literal("model.retry"),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  z.object({ type: z.literal("tool.call"), id: z.string(), name: z.string(), input: z.unknown(), inputHash: z.string(), context: InstructionContextSchema.optional(), internal: InternalToolSchema.optional() }),
  z.object({
    type: z.literal("tool.result"),
    internal: InternalToolSchema.optional(),
    diagnostics: DiagnosticsSchema.optional(),
    id: z.string(),
    ok: z.boolean(),
    display: z.string(),
    durationMs: z.number().int(),
    /** Resolved by core after validation/permission, never supplied by tool output. */
    permission: PermissionClass.optional(),
    toolCallSeq: z.number().int().nonnegative().optional(),
    /** Internal foreground execution receipt captured before output hooks. Legacy absence is unknown. */
    commandOutcome: CommandOutcome.optional(),
    /** Bounded builtin before/after observation, never returned model metadata. */
    fileDiff: FileDiff.optional(),
    /** Complete textual output for a display-overflow artifact; its handle is this event's seq. */
    output: z.string().optional(),
    /** The tool stopped collecting or did not supply its full text; even an output artifact
     * contains only the recorded portion. Distinct from representational display truncation. */
    outputIncomplete: z.boolean().optional(),
    /** Additive for compatibility with logs written before output artifacts existed. */
    truncated: z.boolean().optional(),
  }),
  /**
   * M7: a `post_tool` hook rewrote or appended to what the MODEL consumed. `tool.result` keeps
   * what the tool actually returned, so without this the log and the model's conversation could
   * diverge silently — and a hook could steer the model with text no observer ever saw.
   */
  z.object({
    type: z.literal("tool.result.patched"),
    internal: InternalToolSchema.optional(),
    id: z.string(),
    by: z.string(),
    display: z.string(),
    /** Additive: absent historical post_tool events are conservatively treated as replacement. */
    mode: z.enum(["modify", "inject"]).optional(),
  }),
  z.object({ type: z.literal("tool.denied"), id: z.string(), name: z.string() }),
  z.object({
    type: z.literal("sandbox.denied"),
    id: z.string(),
    name: z.string(),
    mode: SandboxMode,
    reason: z.string(),
  }),
  z.object({ type: z.literal("file.changed"), path: z.string(), op: z.enum(["create", "edit", "delete"]), contentHash: z.string(),
    /** Core-stamped emitting call; legacy/unattributed claims prove no progress. */
    toolCallSeq: z.number().int().nonnegative().optional() }),
  z.object({
    type: z.literal("checkpoint.created"),
    turn: z.number().int().positive(),
    ref: z.string().regex(/^refs\/(?:worktree\/)?agentrig\/[A-Za-z0-9_-]{1,128}\/[1-9][0-9]*$/),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  z.object({ type: z.literal("checkpoint.warning"), message: z.string() }),
  z.object({
    type: z.literal("checkpoint.sealed"), turn: z.number().int().positive(),
    ref: z.string().regex(/^refs\/(?:worktree\/)?agentrig\/[A-Za-z0-9_-]{1,128}\/sealed\/[1-9][0-9]*$/),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    repo: z.string().min(1), excludes: z.array(z.string()), head: z.string().min(1),
    indexHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    type:z.literal("checkpoint.restored"),targetSession:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),turn:z.number().int().positive(),
    ref:z.string().regex(/^refs\/(?:worktree\/)?agentrig\/[A-Za-z0-9_-]{1,128}\/[1-9][0-9]*$/),
    tree:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),recovery:z.string().min(1),
  }),
  z.object({ type: z.literal("permission.request"), req: PermissionRequest }),
  z.object({ type: z.literal("permission.decision"), d: Decision,
    toolUseId: z.string().optional(), tool: z.string().optional(), source: PermissionDecisionSourceSchema.optional() }),
  z.object({ type: z.literal("permission.expansion"), id: z.string(), name: z.string(),
    surface: z.enum(["exec", "network", "write-outside-cwd"]), decision: z.enum(["allow", "deny"]),
    sourceOrigin: z.string().optional() }),
  ...PermissionGrantEventSchema.options,
  z.object({
    type: z.literal("context.compact"),
    estimate: z.object({ scope: z.literal("transcript"), beforeBytes: z.number().int().nonnegative(), afterBytes: z.number().int().nonnegative() }).optional(),
    before: z.number().int(),
    after: z.number().int(),
    /** Additive authoritative post-compaction state; absent on historical logs. */
    messages: z.array(MessageSchema).optional(),
  }),
  z.object({
    type: z.literal("context.evicted"),
    count: z.number().int().positive(),
    bytesSaved: z.number().int().positive(),
  }),
  z.object({ type: z.literal("context.loaded"), path: z.string(), bytes: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("context.manifest"),
    turn: z.number().int().positive(),
    providerSelection: ProviderSelectionInfoSchema.optional(),
    requestHash: z.string(),
    blocks: z.array(z.object({
      source: z.enum([
        "system_prompt",
        "project_instructions",
        "repo_map",
        "memory_index",
        "skills_catalogue",
        "history",
        "tool_result",
        "tool_catalogue",
        "git_state",
      ]),
      origin: z.string(),
      authority: z.enum(["instruction", "data"]),
      context: InstructionContextSchema.optional(),
      hash: z.string(),
      reason: z.string(),
      bytes: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      disposition: z.enum(["kept", "evicted"]),
      freshness: z.string().optional(),
    })),
  }),
  z.object({
    type: z.literal("context.repo_map"),
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    truncated: z.boolean(),
    freshness: z.string(),
  }),
  z.object({ type: z.literal("plan.updated"), items: z.array(PlanItem) }),
  z.object({
    type: z.literal("extension.loaded"),
    name: z.string(), path: z.string(),
    disabled: z.literal(true).optional(),
    surfaces: z.object({ hooks: z.array(z.string()), tools: z.array(z.string()), commands: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal("extension.error"),
    name: z.string(), path: z.string(), phase: z.enum(["manifest", "import", "activate", "hook", "tool", "command"]), message: z.string(),
    surface: z.string().optional(), disabled: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("skill.used"),
    name: z.string(),
    /**
     * Who chose to load the skill (issue #62): "model" is emitted by the `skill` tool when the
     * model fetches a body; "user" is reserved for a core-side user-invocation seam — today a TUI
     * `/skill-name` invocation is recorded as the delimited block in the user turn itself, since
     * the CLI cannot (by design) append events to the session log.
     */
    invokedBy: z.enum(["model", "user"]),
    /** Selected skill's validated manifest label; never proof of generation, approval or benefit. */
    generated: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("subagent.spawn"), id: z.string(), task: z.string(),
    role: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), hash: z.string().regex(/^[a-f0-9]{64}$/),
      tools: z.array(z.string().max(128)).max(64), modelRole: z.enum(["main", "supervisor", "memory", "subagents"]),
      delegable: z.boolean(), maxTurns: z.number().int().positive() }).strict().optional() }),
  z.object({
    type: z.literal("subagent.end"),
    id: z.string(),
    /** M7: how the child finished. Optional so logs written before this still parse. */
    reason: z.enum(["done", "aborted", "error", "budget"]).optional(),
  }),
  z.object({ type: z.literal("steer"), source: z.enum(["user", "supervisor", "hook"]), message: z.string(), context: InstructionContextSchema.optional() }),
  z.object({ type: z.literal("memory.note"), scope: z.enum(["project", "global"]), path: z.string() }),
  SupervisorSignalEvent,
  SupervisorInterventionEvent,
  SupervisorOutcomeEvent,
  AuxiliaryUsageRecord,
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
