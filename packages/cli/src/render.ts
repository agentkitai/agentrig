import { safeSliceEnd, type EventOf, type HarnessEvent, type Intervention } from "@agentkitai/agentrig-core";

/**
 * Two views of one event stream.
 *
 * `renderEvent` is the trace: every event, one line, timestamps and hashes — what you want when
 * something went wrong. `renderChatEvent` is the conversation: the model's answer, what it did,
 * and anything that needs a decision. A person asking a question does not need `turn.start`,
 * `model.request` and `model.response`, and burying the answer in them is how the answer went
 * missing entirely — the deltas that carry it were dropped by both surfaces.
 */

/** One line per event. Kept dumb on purpose: the TUI (M7) replaces this. */
export function renderEvent(e: HarnessEvent): string {
  const t = new Date(e.ts).toISOString().slice(11, 23);
  const p = `${String(e.seq).padStart(4)} ${t} ${e.type.padEnd(22)}`;
  switch (e.type) {
    case "session.start": return `${p} ${e.provider}/${e.model} cwd=${e.cwd} task=${JSON.stringify(e.task)}`;
    case "session.resume": return `${p} ${e.provider}/${e.model} cwd=${e.cwd} task=${JSON.stringify(e.task)}`;
    case "session.end": return `${p} reason=${e.reason}`;
    case "turn.start":
    case "turn.end": return `${p} n=${e.n}`;
    case "model.request": return `${p} tokensIn=${e.tokensIn}`;
    case "model.delta": return `${p} ${JSON.stringify(e.text)}`;
    case "model.response": return `${p} in=${e.usage.input} out=${e.usage.output} stop=${e.stop}`;
    case "model.retry": return `${p} attempt=${e.attempt}/${e.maxAttempts} delay=${e.delayMs}ms ${JSON.stringify(e.reason)}`;
    case "tool.call": return `${p} ${e.name}#${e.id} hash=${e.inputHash} ${JSON.stringify(e.input)}`;
    case "tool.result": {
      const artifact = e.truncated === true && e.output !== undefined
        ? ` artifact={"seq":${e.seq},"from":0,"to":${safeSliceEnd(e.output, Math.min(30_000, e.output.length))}}`
        : "";
      return `${p} #${e.id} ok=${e.ok} ${e.durationMs}ms${artifact} ${JSON.stringify(e.display.slice(0, 80))}`;
    }
    case "tool.result.patched": return `${p} ${e.by} rewrote what the model saw: ${e.display.replace(/\s+/g, " ").slice(0, 160)}`;
    case "tool.denied": return `${p} ${e.name}#${e.id}`;
    case "file.changed": return `${p} ${e.op} ${e.path} hash=${e.contentHash}`;
    case "permission.request":
      return `${p} ${e.req.tool} [${e.req.class}]${e.req.origin === undefined ? "" : ` (${e.req.origin})`}`;
    case "permission.decision": return `${p} ${e.d}`;
    case "context.compact": return `${p} ${e.before} -> ${e.after}`;
    case "context.evicted": return `${p} count=${e.count} saved=${e.bytesSaved} bytes`;
    case "context.loaded": return `${p} ${e.path} ${e.bytes} bytes`;
    case "context.manifest": return `${p} turn=${e.turn} blocks=${e.blocks.length} request=${e.requestHash}`;
    case "context.repo_map": return `${p} files=${e.files} bytes=${e.bytes} truncated=${e.truncated} freshness=${e.freshness.slice(0, 12)}`;
    case "plan.updated": return `${p} ${e.items.map((i) => `${i.status}:${i.text}`).join(" | ")}`;
    case "subagent.spawn": return `${p} ${e.id} ${JSON.stringify(e.task)}`;
    case "subagent.end": return `${p} ${e.id}${e.reason === undefined ? "" : ` ${e.reason}`}`;
    case "steer": return `${p} from=${e.source} ${JSON.stringify(e.message)}`;
    case "memory.note": return `${p} ${e.scope}:${e.path}`;
    case "supervisor.signal": return `${p} ${e.signal.type} conf=${e.signal.confidence} ${e.signal.evidence.join("; ")}`;
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
 * Hidden: session start/resume/end, turn boundaries, model requests and responses, permission
 * decisions, compaction, memory notes. Each is real and each is in the log; none of them is
 * something a person reads while waiting for an answer.
 */
export function renderChatEvent(e: HarnessEvent): string | null {
  switch (e.type) {
    case "tool.call":
      return `⚒ ${toolSummary(e.name, e.input)}`;
    case "tool.result":
      // a successful tool is noise; a failing one is the thing that explains the next turn
      return e.ok ? null : `✗ ${oneLine(e.display)}`;
    case "tool.result.patched":
      return `✎ ${e.by} rewrote what the model saw`;
    case "tool.denied":
      return `✗ denied ${e.name}`;
    case "file.changed":
      return `± ${e.op} ${e.path}`;
    case "plan.updated": {
      const current = e.items.find((i) => i.status === "in_progress") ?? e.items.find((i) => i.status === "pending");
      const done = e.items.filter((i) => i.status === "done").length;
      return `▸ plan ${done}/${e.items.length}${current === undefined ? "" : `: ${oneLine(current.text, 80)}`}`;
    }
    case "subagent.spawn":
      return `⤷ subagent: ${oneLine(e.task, 80)}`;
    case "subagent.end":
      return e.reason === "done" ? null : `⤶ subagent ${e.reason ?? "ended"}`;
    case "steer":
      return `↪ ${e.source}: ${oneLine(e.message)}`;
    case "supervisor.signal":
      return `⚠ ${e.signal.type} (${e.signal.confidence}) ${oneLine(e.signal.evidence.join("; "), 80)}`;
    case "supervisor.intervention": {
      const detail = interventionDetail(e.intervention);
      return `⚠ ${e.intervention.type}${detail === "" ? "" : `: ${oneLine(detail, 160)}`}`;
    }
    case "error":
      return `! ${oneLine(e.message, 200)}`;
    case "session.end":
      // "done" is already said by the summary line; anything else is why it stopped
      return e.reason === "done" ? null : `— session ${e.reason}`;
    case "session.start":
    case "session.resume":
    case "turn.start":
    case "turn.end":
    case "model.request":
    case "model.delta":
    case "model.response":
    // the provider's onNotice already prints the friendly retry line; a chat line here would double it
    case "model.retry":
    case "permission.request":
    case "permission.decision":
    case "context.compact":
    case "context.evicted":
    case "context.loaded":
    case "context.manifest":
    case "context.repo_map":
    case "memory.note":
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
