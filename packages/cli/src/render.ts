import { safeSliceEnd, type AuxiliaryReport, type EventOf, type HarnessEvent, type Intervention, type Usage, type PermissionDecisionSource } from "@agentkitai/agentrig-core";
import { formatAuxiliaryUsage } from "@agentkitai/agentrig-memory";
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
      return `${p} ${e.intervention.type}${detail === "" ? "" : `: ${detail.replace(/\s+/g, " ").slice(0, 200)}`}`;
    }
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

/** Fit a value on one line, for a view that is read rather than grepped. */
function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Declaration metadata only; no evidence matcher has evaluated this check. */
export function renderPlanAcceptance(accept: string | undefined): string {
  return `accept: ${accept === undefined ? "undeclared (unverified)" : `${JSON.stringify(accept)} (declared, unverified)`}`;
}

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
      const detail = interventionDetail(e.intervention);
      return `⚠ ${e.intervention.type}${detail === "" ? "" : `: ${oneLine(detail, 160)}`}`;
    }
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
