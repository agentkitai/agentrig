import { contentHash, renderPlanAcceptance, sanitizeLine, safeSliceEnd, type AuxiliaryReport, type EventOf, type GuidanceDecision, type HarnessEvent,
  type InjectedGuidance, type Intervention, type InterventionCost, type Signal, type TurnExplanation, type Usage,
  type PermissionDecisionSource } from "@agentkitai/agentrig-core";
import { formatAuxiliaryUsage, MEMORY_RECALL_TOOLS, recallEvidence, type RecallEvidence } from "@agentkitai/agentrig-memory";
import { renderFileDiff } from "./file-diff.js";

function permissionSource(source: PermissionDecisionSource): string {
  switch (source.kind) {
    case "rule": return `rule #${source.index} ${JSON.stringify(source.rule)}`;
    case "fallback": return "policy fallback (no rule matched)";
    case "grant": return `grant ${source.grantId}`;
    case "approval-handler": return "approval handler (human/host)";
    case "unattended": return "no approval handler (unattended deny)";
    case "boundary": return `boundary ${JSON.stringify(source.reason)}`;
    case "unknown": return "policy attribution unknown";
  }
}
function permissionExplanation(event: EventOf<"permission.decision">): string {
  return `${event.d}${event.tool === undefined ? "" : ` ${JSON.stringify(event.tool)}`}${event.toolUseId === undefined ? "" : ` [${JSON.stringify(event.toolUseId)}]`}${event.source === undefined ? "" : ` — ${permissionSource(event.source)}`}`;
}

/** Surface unfinished paid work at session end, even if its final snapshot was too late for
 * the closed log. Cumulative snapshots replace by run id; they never inflate main usage. */
export class AuxiliaryText {
  private readonly pending = new Map<string, AuxiliaryReport>();
  push(event: HarnessEvent): string[] {
    if (event.type === "session.start" || event.type === "session.resume") this.pending.clear();
    if (event.type === "auxiliary.usage") {
      if (event.final) this.pending.delete(event.id);
      else this.pending.set(event.id, event.report);
    }
    if (event.type !== "session.end") return [];
    const lines = [...this.pending.values()].map(report => formatAuxiliaryUsage(report, { final: false }));
    this.pending.clear(); return lines;
  }
}

/**
 * Two views of one event stream.
 *
 * `renderEvent` is the trace: every event, one line, timestamps and hashes — what you want when
 * something went wrong. `renderChatEvent` is the conversation: the model's answer, what it did,
 * and anything that needs a decision. A person asking a question does not need `turn.start`,
 * `model.request` and `model.response`, and burying the answer in them is how the answer went
 * missing entirely — the deltas that carry it were dropped by both surfaces.
 */

/** Compact token count for usage summaries; floors so a display never overstates spend. */
function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const [value, unit] = n < 1_000_000 ? [n / 1_000, "k"] : [n / 1_000_000, "M"];
  const floored = Math.floor(value * 10) / 10;
  return `${floored % 1 === 0 ? floored.toFixed(0) : floored.toFixed(1)}${unit}`;
}

/** User-facing usage: total input first, with cache reads identified as its discounted subset. */
export function formatUsage(usage: Usage): string {
  const input = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const detail = [
    ...(usage.cacheRead === undefined || usage.cacheRead === 0 ? [] : [`${formatTokens(usage.cacheRead)} cached`]),
    ...(usage.cacheWrite === undefined || usage.cacheWrite === 0 ? [] : [`${formatTokens(usage.cacheWrite)} written`]),
  ];
  return `${formatTokens(input)} in${detail.length === 0 ? "" : ` (${detail.join(", ")})`} / ${formatTokens(usage.output)} out`;
}

/** One line per event. Kept dumb on purpose: the TUI (M7) replaces this. */
export function renderEvent(e: HarnessEvent): string {
  const t = new Date(e.ts).toISOString().slice(11, 23);
  const p = `${String(e.seq).padStart(4)} ${t} ${e.type.padEnd(22)}`;
  switch (e.type) {
    case "session.start":
      return `${p} ${e.provider}/${e.model} cwd=${e.cwd}${e.parent === undefined ? "" : ` parent=${e.parent}`} task=${JSON.stringify(e.task)}${e.advisoryContext === undefined ? "" : ` advisory-context=${e.advisoryContext.length}`}`;
    case "session.fork": return `${p} parent=${e.parent} atSeq=${e.atSeq}`;
    case "session.resume": return `${p} ${e.provider}/${e.model} cwd=${e.cwd} task=${JSON.stringify(e.task)}${e.maintenance === undefined ? "" : ` maintenance=${e.maintenance}`}${e.advisoryContext === undefined ? "" : ` advisory-context=${e.advisoryContext.length}`}`;
    case "run.scheduled": return `${p} ${e.source === "heartbeat" ? "heartbeat" : `schedule=${e.entryId}`} UTC-minute=${e.minute} (advisory task)`;
    case "session.end": return `${p} reason=${e.reason}`;
    case "output.validated": return `${p} ${e.mode} ${e.attempt} valid=${e.valid} category=${e.category} schema=${e.digest}`;
    case "question.asked": return `${p} ${e.id} ${JSON.stringify(e.question.prompt)} options=${JSON.stringify(e.question.options)}`;
    case "question.answered": return `${p} ${e.id} ${e.outcome}${e.reply === undefined ? "" : ` source=${e.reply.source} ${JSON.stringify(e.reply.answer)}`}`;
    case "eval.result": return `${p} ${JSON.stringify(e.task)} ${e.outcome} (baseline ${e.baselineOutcome}) profile=${JSON.stringify(e.profile)} reportedTokens=${e.reportedTokens} usage=${e.usageComplete ? "complete" : "unknown"} advisory=${e.advisoryPass === null ? "unavailable" : e.advisoryPass ? "pass" : "fail"}`;
    case "turn.start":
    case "turn.end": return `${p} n=${e.n}`;
    case "turn.continued": return `${p} n=${e.n} from=${e.from} attempt=${e.attempt}/${e.maxAttempts} reason=${e.reason}`;
    case "model.request": return `${p} tokensIn=${e.tokensIn}`;
    case "budget.cap": return `${p} configured-estimate cap ${e.reason} (not invoice accounting)`;
    case "model.delta": return `${p} ${JSON.stringify(e.text)}`;
    case "model.response": {
      const input = e.usage.input + (e.usage.cacheRead ?? 0) + (e.usage.cacheWrite ?? 0);
      const cacheRead = e.usage.cacheRead === undefined || e.usage.cacheRead === 0
        ? ""
        : ` cached=${formatTokens(e.usage.cacheRead)}`;
      const cacheWrite = e.usage.cacheWrite === undefined || e.usage.cacheWrite === 0
        ? ""
        : ` cacheWrite=${formatTokens(e.usage.cacheWrite)}`;
      return `${p} in=${formatTokens(input)}${cacheRead}${cacheWrite} out=${formatTokens(e.usage.output)} stop=${e.stop}${e.usageComplete === true ? "" : " total-usage=unknown"}`;
    }
    case "message.append": return `${p} role=${e.message.role} blocks=${e.message.content.length}`;
    case "model.retry": return `${p} attempt=${e.attempt}/${e.maxAttempts} delay=${e.delayMs}ms ${JSON.stringify(e.reason)}`;
    case "tool.call": return `${p} ${e.name}#${e.id} hash=${e.inputHash}${e.internal === undefined ? "" : ` internal=${e.internal.kind} parent=${e.internal.parentToolUseId}`} ${JSON.stringify(e.input)}`;
    case "tool.result": {
      const artifact = e.truncated === true && e.output !== undefined
        ? ` artifact={"seq":${e.seq},"from":0,"to":${safeSliceEnd(e.output, Math.min(30_000, e.output.length))}}`
        : "";
      return `${p} #${e.id} ok=${e.ok} ${e.durationMs}ms${artifact}${e.diagnostics === undefined ? "" : ` diagnostics=${e.diagnostics.status} entries=${e.diagnostics.entries.length} other=${e.diagnostics.otherFileCount}`} ${JSON.stringify(e.display.slice(0, 80))}`;
    }
    case "tool.result.patched": return `${p} ${e.by} rewrote what the model saw: ${e.display.replace(/\s+/g, " ").slice(0, 160)}`;
    case "tool.denied": return `${p} ${e.name}#${e.id}`;
    case "sandbox.denied": return `${p} ${e.name}#${e.id} mode=${e.mode} ${JSON.stringify(e.reason)}`;
    case "file.changed": return `${p} ${e.op} ${e.path} hash=${e.contentHash}${e.toolCallSeq === undefined ? "" : ` claim from tool.call #${e.toolCallSeq}`}`;
    case "checkpoint.created": return `${p} turn=${e.turn} ref=${e.ref} commit=${e.commit} tree=${e.tree}`;
    case "checkpoint.warning": return `${p} ${e.message}`;
    case "checkpoint.sealed": return `${p} turn=${e.turn} tree=${e.tree} ref=${e.ref}`;
    case "checkpoint.restored": return `${p} session=${e.targetSession} turn=${e.turn} recovery=${e.recovery}`;
    case "permission.request":
      return `${p} ${e.req.tool} [${e.req.class}]${e.req.origin === undefined ? "" : ` (${e.req.origin})`}${e.req.operation === undefined ? "" : ` operation=${JSON.stringify(e.req.operation)}`}`;
    case "permission.decision": return `${p} ${permissionExplanation(e)}`;
    case "permission.expansion": return `${p} ${e.decision} first ${e.surface}: ${e.name}${e.sourceOrigin === undefined ? "" : ` from ${e.sourceOrigin}`}`;
    case "permission.granted": return `${p} ${e.grant.id} ${e.grant.decision} ${e.grant.operation.tool} ${JSON.stringify(e.grant.resource)} ${e.grant.duration.kind}=${e.grant.duration.id}`;
    case "permission.revoked": return `${p} ${e.grantId} ${e.reason}`;
    case "context.compact": return `${p} ${e.before} -> ${e.after}${e.estimate === undefined ? "" : ` transcript-only estimate; bytes ${e.estimate.beforeBytes} -> ${e.estimate.afterBytes}`}`;
    case "context.evicted": return `${p} count=${e.count} saved=${e.bytesSaved} bytes`;
    case "context.loaded": return `${p} ${e.path} ${e.bytes} bytes`;
    case "provider.switched": return `${p} turn=${e.turn} ${JSON.stringify(e.from ?? "unknown")} -> ${JSON.stringify(e.to)}`;
    case "context.manifest": return `${p} turn=${e.turn} blocks=${e.blocks.length} request=${e.requestHash}${e.providerSelection === undefined ? "" : ` provider=${JSON.stringify(e.providerSelection)}`}`;
    case "context.repo_map": return `${p} files=${e.files} bytes=${e.bytes} truncated=${e.truncated} freshness=${e.freshness.slice(0, 12)}`;
    case "plan.updated": return `${p} ${e.items.map((i) => `${i.status}:${i.text}; ${renderPlanAcceptance(i.accept)}`).join(" | ")}`;
    case "extension.loaded": return `${p} ${e.name}${e.disabled === true ? " (disabled; not reactivated)" : ""} hooks=${e.surfaces.hooks.join(",")} tools=${e.surfaces.tools.join(",")} commands=${e.surfaces.commands.join(",")}`;
    case "extension.error": return `${p} ${e.name} ${e.phase}${e.surface === undefined ? "" : `/${e.surface}`}${e.disabled === true ? " (disabled)" : ""}: ${e.message}`;
    case "skill.used": return `${p} ${e.name} by=${e.invokedBy}${e.generated === true ? " generated=true" : ""}`;
    case "subagent.spawn": return `${p} ${e.id} ${JSON.stringify(e.task)}${e.role === undefined ? "" : ` role=${e.role.name} maxTurns=${e.role.maxTurns} tools=${e.role.tools.join(",")}`}`;
    case "subagent.end": return `${p} ${e.id}${e.reason === undefined ? "" : ` ${e.reason}`}`;
    case "steer": return `${p} from=${e.source} ${JSON.stringify(e.message)}`;
    case "context.delegation": return `${p} ${e.action} principal=${JSON.stringify(e.principal)} receipt=${e.delegation}`;
    case "memory.note": return `${p} ${e.scope}:${e.path}`;
    case "supervisor.signal": return `${p} ${e.signal.type} conf=${e.signal.confidence} ${e.signal.evidence.join("; ")}`;
    case "auxiliary.usage": return `${p} ${e.id} ${e.final ? "final" : "provisional"} ${formatAuxiliaryUsage(e.report, { final: e.final })}`;
    case "supervisor.intervention": {
      const detail = interventionDetail(e.intervention);
      const noticed = e.noticed === undefined || e.noticed.length === 0 ? "" : ` noticed=${JSON.stringify(renderNotice(e.noticed))}`;
      return `${p} ${e.intervention.type}${e.id === undefined ? "" : ` id=${e.id}`}${noticed} (decision, not yet applied)${detail === "" ? "" : `: ${detail.replace(/\s+/g, " ").slice(0, 200)}`}`;
    }
    case "supervisor.outcome": return `${p} ${e.intervention} id=${e.id} ${renderOutcome(e)}`;
    case "error": return `${p} fatal=${e.fatal} ${e.message}`;
  }
}

/** Whatever the rung carries that a reader needs; shared by both views. */
function interventionDetail(i: Intervention): string {
  return i.type === "inject_guidance" ? i.message
    : i.type === "escalate" ? i.question
    : i.type === "abort" ? i.reason
    : i.type === "run_reviewer" ? i.reason
    : i.type === "run_grader" ? i.rubric
    : i.type === "checkpoint_rollback" ? `to seq ${i.toSeq}`
    : "";
}

/**
 * R17e. What one signal noticed, short enough to sit on the intervention's own line. The evidence
 * strings come from detectors, which read tool output — so they are sanitised like any other
 * untrusted text before they reach a terminal.
 */
export function renderNotice(signals: readonly Signal[]): string {
  if (signals.length === 0) return "";
  const first = signals[0]!;
  const evidence = first.evidence.length === 0 ? "" : `: ${sanitizeLine(first.evidence.join("; "), 100)}`;
  const more = signals.length === 1 ? "" : ` (+${signals.length - 1} more signal${signals.length === 2 ? "" : "s"})`;
  return `${first.type} (${first.confidence.toFixed(2)})${evidence}${more}`;
}

/**
 * R17e. The only cost claims the harness can stand behind.
 *
 * A heuristic rung is local computation, so "no model call" is a fact rather than an estimate. An
 * LLM-backed rung's consumption stays in its own `auxiliary.usage` record — pointed at, never
 * copied, because an unfinished snapshot means total usage is UNKNOWN and summing it here would
 * manufacture a number. Injected bytes are the size of the text queued for the prompt, with the
 * same ~4-bytes-per-token estimate the context manifest uses; they are not billed tokens, which
 * only the provider's own usage can establish.
 */
export function renderInterventionCost(cost: InterventionCost): string {
  const parts = [
    cost.modelCalls === "none"
      ? "no model call"
      : `auxiliary run${cost.auxiliaryId === undefined ? "" : ` [${cost.auxiliaryId.slice(0, 8)}]`}, actual calls and usage in its own record`,
  ];
  if (cost.injected !== undefined) {
    parts.push(`+${cost.injected.bytes} B of prompt (~${Math.ceil(cost.injected.bytes / 4)} est. tokens, not billed tokens)`);
  }
  return parts.join(" · ");
}

/** What applying the rung did. `queued` is deliberately not `applied`: the steer event is the proof. */
function renderOutcome(e: EventOf<"supervisor.outcome">): string {
  return `${e.outcome}${e.detail === undefined ? "" : ` — ${sanitizeLine(e.detail, 160)}`} · ${renderInterventionCost(e.cost)}`;
}

/**
 * R17e. Memory recalls as page and claim rather than a result count, for both chat surfaces.
 *
 * Pairs a memory retrieval `tool.call` with its `tool.result`, because the result event does not
 * carry the tool name. Nothing is rendered for a failed, denied or unmatched call: the existing
 * failure line already says what happened, and inventing "memory says …" from an error is exactly
 * the false claim this row exists to prevent.
 */
export class RecallText {
  private readonly pending = new Map<string, { name: string; input: unknown }>();
  private readonly completed = new Map<string, { name: string; input: unknown }>();
  private session: string | undefined;
  /** Bounded like the tool-summary pairing: an unmatched call must not grow without limit. */
  private static readonly MAX_PENDING = 64;

  push(e: HarnessEvent): string[] {
    if (this.session !== e.sessionId) { this.pending.clear(); this.completed.clear(); this.session = e.sessionId; }
    if (e.type === "session.start" || e.type === "session.resume" || e.type === "session.fork"
      || e.type === "session.end") { this.pending.clear(); this.completed.clear(); }
    if (e.type === "turn.end") this.completed.clear();
    if (e.type === "tool.call" && MEMORY_RECALL_TOOLS.has(e.name) && e.internal === undefined) {
      if (this.pending.size >= RecallText.MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(e.id, { name: e.name, input: e.input });
    }
    if (e.type === "tool.result.patched") {
      const call = this.completed.get(e.id);
      if (call === undefined || e.internal !== undefined) return [];
      return [`✻ memory result updated (${call.name}) by ${sanitizeLine(e.by, 80)} — model-facing content, not a verified memory claim:`,
        ...quote(e.display, 8)];
    }
    if (e.type !== "tool.result") return [];
    const call = this.pending.get(e.id);
    if (call === undefined) return [];
    this.pending.delete(e.id);
    if (this.completed.size >= RecallText.MAX_PENDING) this.completed.delete(this.completed.keys().next().value!);
    this.completed.set(e.id, call);
    const evidence = recallEvidence({
      tool: call.name,
      input: call.input,
      display: e.display,
      ok: e.ok,
      ...(e.truncated === undefined ? {} : { truncated: e.truncated }),
      ...(e.outputIncomplete === undefined ? {} : { outputIncomplete: e.outputIncomplete }),
    });
    return evidence === null ? [] : renderRecall(evidence);
  }
}

/** One header line naming the recall, then one line per page: the page, and the claim that matched. */
export function renderRecall(evidence: RecallEvidence): string[] {
  const subject = evidence.subject === "" ? "" : ` ${JSON.stringify(sanitizeLine(evidence.subject, 80))}`;
  if (evidence.empty) {
    return [`✻ memory recall (${evidence.tool})${subject}: nothing recalled${evidence.incomplete ? "; the tool's own output was cut short" : ""}`];
  }
  const lines = [`✻ memory recall (${evidence.tool})${subject}`];
  for (const page of evidence.pages) {
    lines.push(`    ${sanitizeLine(page.page, 100)} [${page.via}] — ${sanitizeLine(page.claim, 160)}`);
  }
  if (evidence.omitted > 0) {
    lines.push(`    …${evidence.omitted} further page(s) omitted from this view; the full result is in the session log`);
  }
  if (evidence.incomplete) {
    lines.push("    the tool's own output was cut short, so this is part of what it found");
  }
  return lines;
}

/**
 * R17e. "Nothing is added to the model prompt that is not also visible" — for memory, that is the
 * index block the harness injects into the system prompt without any tool call.
 *
 * Read from `context.manifest`, which is measured from the request that was actually sent, and
 * announced when it appears or changes rather than every turn.
 */
export class MemoryContextText {
  private announced: string | undefined;
  private session: string | undefined;

  push(e: HarnessEvent): string[] {
    if (this.session !== e.sessionId) { this.announced = undefined; this.session = e.sessionId; }
    if (e.type === "session.start" || e.type === "session.resume" || e.type === "session.fork") this.announced = undefined;
    if (e.type !== "context.manifest") return [];
    const block = e.blocks.find((b) => b.source === "memory_index" && b.disposition === "kept");
    if (block === undefined || block.hash === this.announced) return [];
    const first = this.announced === undefined;
    this.announced = block.hash;
    return [`✻ memory in the prompt: ${first ? "index injected" : "index changed"} — ${block.bytes} B, ~${block.tokens} est. tokens,`
      + ` origin ${sanitizeLine(block.origin, 60)} (no tool call; /why shows it)`];
  }
}

/** Human-readable prompt bill of materials used by the TUI's `/context` command. */
export function renderContextManifest(event: EventOf<"context.manifest">): string {
  const totalBytes = event.blocks.reduce((sum, block) => sum + block.bytes, 0);
  const totalTokens = event.blocks.reduce((sum, block) => sum + block.tokens, 0);
  const lines = [
    `context turn ${event.turn} — ${event.blocks.length} blocks, ${totalBytes} bytes, ~${totalTokens} tokens`,
    `request hash ${event.requestHash}`,
  ];
  if (event.providerSelection !== undefined) lines.push(`provider ${JSON.stringify(event.providerSelection)}`);
  for (const block of event.blocks) {
    const freshness = block.freshness === undefined ? "" : ` fresh=${block.freshness}`;
    lines.push(
      `${block.disposition === "evicted" ? "evicted" : "kept"} ${block.source} ${block.authority} ` +
      `${block.bytes}B ~${block.tokens}t hash=${block.hash}${freshness} origin=${block.origin} — ${block.reason}`,
    );
  }
  return lines.join("\n");
}

export interface WhyOptions {
  /**
   * The memory index this process injected. Used only to CHECK the manifest's hash — the answer
   * is either "this is the text that went out" or "unavailable", never a re-read that might have
   * changed since the request was built.
   */
  memoryIndex?: string;
  /** Lines of injected text shown per entry before the rest is declared omitted. */
  maxLines?: number;
}

/** Bounded, sanitised quote of text that went to the model; the log keeps the whole thing. */
function quote(text: string, maxLines: number): string[] {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).map((line) => `      | ${sanitizeLine(line, 160)}`);
  if (lines.length > maxLines) shown.push(`      | …${lines.length - maxLines} more line(s) omitted here; the session log has the full text`);
  return shown;
}

function renderDecision(decision: GuidanceDecision): string[] {
  const lines = [`     decision: ${decision.intervention.type}${decision.id === undefined ? "" : ` [${decision.id.slice(0, 8)}]`} recorded at seq ${decision.seq}`];
  if (decision.noticed.length > 0) lines.push(`     noticed: ${renderNotice(decision.noticed)}`);
  else lines.push("     noticed: not recorded (this log predates R17e attribution)");
  lines.push(decision.outcome === undefined
    ? "     outcome: not recorded"
    : `     outcome: ${decision.outcome.outcome}${decision.outcome.detail === undefined ? "" : ` — ${sanitizeLine(decision.outcome.detail, 160)}`}`);
  if (decision.outcome !== undefined) lines.push(`     cost: ${renderInterventionCost(decision.outcome.cost)}`);
  return lines;
}

function renderInjected(entry: InjectedGuidance, index: number, maxLines: number): string[] {
  const origin = entry.source === "user" ? "you typed it"
    : entry.source === "supervisor" ? "the supervisor injected it"
    : `a hook injected it${entry.context === undefined ? "" : ` (${sanitizeLine(entry.context.principal, 60)})`}`;
  const lines = [`  ${index}. ${entry.source} — ${origin} · ${entry.bytes} B (~${Math.ceil(entry.bytes / 4)} est. tokens)`];
  if (entry.source === "supervisor") {
    lines.push(...(entry.decision === undefined
      ? ["     decision: no recorded supervisor decision matches this text"]
      : renderDecision(entry.decision)));
  }
  lines.push(...quote(entry.message, maxLines));
  return lines;
}

/**
 * R17e's `/why`: everything the supervisor and memory put in front of the model for the last turn,
 * and nothing they only proposed.
 *
 * Local and read-only by construction — it renders a fold of events this process already saw. It
 * makes no provider call, reads no file, and never reports queued-but-undelivered guidance as
 * injected.
 */
export function renderWhy(explanation: TurnExplanation | null, opts: WhyOptions = {}): string {
  if (explanation === null) {
    return "why: no turn has run in this conversation yet — nothing has been sent to the model to explain";
  }
  const maxLines = opts.maxLines ?? 8;
  const out = [
    `why — turn ${explanation.turn} of session ${explanation.sessionId} (${explanation.complete ? "finished" : "in progress"})`,
  ];

  out.push(explanation.injected.length === 0
    ? "\nInjected guidance: none. Nothing was added to this turn's conversation by the supervisor, a hook, or a steer."
    : explanation.requestRecorded
      ? `\nInjected guidance (${explanation.injected.length}), included in this turn's recorded request attempt (remote receipt is not observable):`
      : `\nConversation guidance (${explanation.injected.length}) — no model request was recorded for this turn; not evidence that the model received it:`);
  explanation.injected.forEach((entry, i) => out.push(...renderInjected(entry, i + 1, maxLines)));

  if (explanation.otherDecisions.length > 0) {
    out.push(`\nOther supervisor decisions in the window that produced this turn (${explanation.otherDecisions.length}), which injected no text:`);
    for (const decision of explanation.otherDecisions) {
      out.push(`  - ${decision.intervention.type}`);
      out.push(...renderDecision(decision).map((line) => `  ${line}`));
    }
  }
  if (explanation.pending.length > 0) {
    out.push(`\nQueued after this turn started (${explanation.pending.length}) — not part of it:`);
    for (const entry of explanation.pending) out.push(`  - ${entry.source}: ${oneLine(entry.message, 120)}`);
  }
  if (explanation.undelivered.length > 0) {
    out.push(`\nNever delivered (${explanation.undelivered.length}) — the session ended first, so the model never saw this:`);
    for (const entry of explanation.undelivered) out.push(`  - ${entry.source}: ${oneLine(entry.message, 120)}`);
  }

  if (explanation.context === null) {
    out.push("\nPrompt context: no manifest was recorded for this turn, so this view cannot say what else the request carried.");
    return out.join("\n");
  }
  const memory = explanation.context.automatic.filter((block) => block.source === "memory_index");
  const other = explanation.context.automatic.filter((block) => block.source !== "memory_index");
  out.push(`\nAutomatic prompt context for this request (${explanation.context.automatic.length} block(s), request ${explanation.context.requestHash}):`);
  if (memory.length === 0) out.push("  memory: no index block was in this request.");
  for (const block of memory) {
    out.push(`  memory index — ${block.bytes} B, ~${block.tokens} est. tokens, ${block.authority} authority, origin ${sanitizeLine(block.origin, 60)}`);
    const known = opts.memoryIndex !== undefined && contentHash(opts.memoryIndex) === block.hash;
    out.push(known
      ? `    ${opts.memoryIndex!.split("\n").filter((line) => line.startsWith("- ")).length} page line(s); content verified against this request's hash ${block.hash}`
      : `    content not held by this view; hash ${block.hash} is the record of what was sent`);
    if (known) out.push(...quote(opts.memoryIndex!, maxLines));
  }
  for (const block of other) {
    out.push(`  ${block.source} — ${block.bytes} B, ~${block.tokens} est. tokens, origin ${sanitizeLine(block.origin, 60)}`);
  }
  out.push(explanation.context.recalls.length === 0
    ? "\nMemory recalls carried in this request's history: none."
    : `\nMemory recalls carried in this request's history (${explanation.context.recalls.length} tool result(s), separate from the automatic context above):`);
  for (const block of explanation.context.recalls) {
    out.push(`  ${sanitizeLine(block.origin, 80)} — ${block.bytes} B, ~${block.tokens} est. tokens, ${block.disposition}`);
  }
  return out.join("\n");
}

/**
 * Fit a value on one line, for a view that is read rather than grepped.
 *
 * Control and bidi characters go too, not just whitespace: several of the values that reach this
 * are text the harness put in front of the model and is now showing back — a steer, a reviewer's
 * guidance, a tool display — and a terminal takes an escape sequence in any of them seriously.
 */
function oneLine(text: string, max = 100): string {
  const flat = sanitizeLine(text, 4096);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export { renderPlanAcceptance };

/** The interesting part of a tool's input: one argument reads better than a JSON blob. */
function toolSummary(name: string, input: unknown): string {
  if (input !== null && typeof input === "object") {
    const o = input as Record<string, unknown>;
    // whichever the tool actually takes; `command` and `path` cover every builtin
    for (const key of ["command", "path", "pattern", "query", "task", "name"]) {
      const v = o[key];
      if (typeof v === "string" && v !== "") return `${name} ${oneLine(v, 80)}`;
    }
  }
  return name;
}

/**
 * The conversation view: what a person watching needs, or `null` for plumbing they do not.
 *
 * Hidden: session start/fork/resume/end, turn boundaries, model requests and responses, permission
 * decisions, compaction, memory notes. Each is real and each is in the log; none of them is
 * something a person reads while waiting for an answer.
 */
export function renderChatEvent(e: HarnessEvent): string | null {
  switch (e.type) {
    case "provider.switched": return `Provider for turn ${e.turn}: ${JSON.stringify(e.to)}${e.from === undefined ? " (previous selection unknown)" : ""}`;
    case "output.validated": return `Output ${e.valid ? "valid" : "invalid"} (${e.mode}, ${e.attempt}, ${e.category})`;
    case "question.asked": return `Question: ${e.question.prompt}`;
    case "question.answered": return `Question ${e.outcome}${e.reply === undefined ? "" : ` (${e.reply.source}): ${"text" in e.reply.answer ? oneLine(e.reply.answer.text) : `option ${e.reply.answer.option + 1}`}`}`;
    case "eval.result": return `Evaluation ${e.task}: ${e.outcome} (baseline ${e.baselineOutcome}; advisory ${e.advisoryPass === null ? "unavailable" : e.advisoryPass ? "pass" : "fail"})`;
    case "auxiliary.usage": return e.final ? formatAuxiliaryUsage(e.report) : null;
    case "tool.call":
      return `⚒ ${toolSummary(e.name, e.input)}`;
    case "tool.result":
      // a successful tool is noise; a failing one is the thing that explains the next turn
      return [e.ok && e.fileDiff !== undefined ? renderFileDiff(e.fileDiff, { color: process.stdout.isTTY === true }) : null,
        e.diagnostics === undefined ? (e.ok ? null : `✗ ${oneLine(e.display)}`)
          : `Diagnostics: ${e.diagnostics.reason}; ${e.diagnostics.entries.length} touched-file, ${e.diagnostics.otherFileCount} other-file, ${e.diagnostics.omitted} omitted`]
        .filter(value => value !== null).join("\n") || null;
    case "tool.result.patched":
      return `✎ ${e.by} rewrote what the model saw`;
    case "tool.denied":
      return `✗ denied ${e.name}`;
    case "file.changed":
      return `± ${e.op} ${e.path}`;
    case "checkpoint.created":
      return `Checkpoint: turn ${e.turn} saved`;
    case "checkpoint.warning":
      return `⚠ ${oneLine(e.message, 200)}`;
    case "plan.updated": {
      const current = e.items.find((i) => i.status === "in_progress") ?? e.items.find((i) => i.status === "pending");
      const done = e.items.filter((i) => i.status === "done").length;
      const declared = e.items.filter(i => i.accept !== undefined).length;
      return `▸ plan ${done}/${e.items.length}${current === undefined ? "" : `: ${oneLine(current.text, 80)}`} · acceptance ${declared}/${e.items.length} declared, unverified`;
    }
    case "subagent.spawn":
      return `⤷ subagent${e.role === undefined ? "" : ` [${e.role.name}]`}: ${oneLine(e.task, 80)}`;
    case "subagent.end":
      return e.reason === "done" ? null : `⤶ subagent ${e.reason ?? "ended"}`;
    case "steer":
      return `↪ ${e.source}: ${oneLine(e.message)}`;
    case "context.delegation":
      return `↪ instruction authority ${e.action}: ${oneLine(e.principal)} (no tool permission)`;
    case "supervisor.signal":
      return `⚠ ${e.signal.type} (${e.signal.confidence}) ${oneLine(e.signal.evidence.join("; "), 80)}`;
    case "supervisor.intervention": {
      // R17e: what it noticed and what it decided, on the line itself. The `supervisor.outcome`
      // line below says what applying it actually did, and what that cost.
      const detail = interventionDetail(e.intervention);
      const noticed = e.noticed === undefined || e.noticed.length === 0 ? "" : `noticed ${renderNotice(e.noticed)} → `;
      return `⚠ supervisor: ${noticed}${e.intervention.type}${detail === "" ? "" : ` — ${oneLine(detail, 160)}`}`;
    }
    case "supervisor.outcome":
      return `  ↳ ${e.intervention} ${renderOutcome(e)}`;
    case "error":
      return `! ${oneLine(e.message, 200)}`;
    case "budget.cap":
      return `! Configured-estimate daily cap: ${e.reason}; not invoice accounting`;
    case "turn.continued":
      return `↻ Response truncated; continuing (${e.attempt}/${e.maxAttempts}, turn ${e.n})`;
    case "permission.decision":
      return e.source === undefined || e.d === "ask" ? null : `permission ${permissionExplanation(e)}`;
    case "session.end":
      // "done" is already said by the summary line; anything else is why it stopped
      return e.reason === "done" ? null : `— session ${e.reason}`;
    case "session.start":
    case "session.fork":
    case "run.scheduled":
    case "session.resume":
    case "turn.start":
    case "turn.end":
    case "model.request":
    case "model.delta":
    case "model.response":
    case "message.append":
    // the provider's onNotice already prints the friendly retry line; a chat line here would double it
    case "model.retry":
    case "permission.request":
    case "permission.expansion":
    case "permission.granted":
    case "permission.revoked":
    case "context.compact":
    case "context.evicted":
    case "context.loaded":
    case "context.manifest":
    case "context.repo_map":
    case "checkpoint.sealed":
    case "checkpoint.restored":
    case "memory.note":
    case "skill.used":
    case "extension.loaded":
    case "extension.error":
    // The adjacent failed tool.result carries the model-facing sandbox error. R2c will add the
    // distinct interactive escalation rendering; do not print this bookkeeping event twice now.
    case "sandbox.denied":
      return null;
  }
}

/**
 * Accumulates `model.delta` into the message a turn produced.
 *
 * Both surfaces dropped `model.delta` outright — the TUI because per-token lines would drown
 * everything, `run` for the same reason — so the assistant's reply was never shown anywhere. The
 * text has to be gathered and emitted once, at the end of the turn that produced it.
 */
export class AssistantText {
  private buffer = "";

  /** The turn in progress, for a live view. */
  get pending(): string {
    return this.buffer;
  }

  /** Feeds one event; returns the finished message when this event completes a turn. */
  push(e: HarnessEvent): string | null {
    if (e.type === "model.delta") {
      this.buffer += e.text;
      return null;
    }
    // a turn that never ended (an abort mid-stream) still said what it said, so `session.end`
    // flushes too rather than discarding it
    if (e.type === "turn.end" || e.type === "session.end") return this.flush();
    return null;
  }

  /** Emits and clears whatever has been gathered, or null when that is nothing. */
  flush(): string | null {
    const text = this.buffer.trim();
    this.buffer = "";
    return text === "" ? null : text;
  }
}
