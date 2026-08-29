import type { HarnessEvent } from "@agentkitai/agentrig-core";

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
    case "tool.call": return `${p} ${e.name}#${e.id} hash=${e.inputHash} ${JSON.stringify(e.input)}`;
    case "tool.result": return `${p} #${e.id} ok=${e.ok} ${e.durationMs}ms ${JSON.stringify(e.display.slice(0, 80))}`;
    case "tool.denied": return `${p} ${e.name}#${e.id}`;
    case "file.changed": return `${p} ${e.op} ${e.path} hash=${e.contentHash}`;
    case "permission.request": return `${p} ${e.req.tool} [${e.req.class}]`;
    case "permission.decision": return `${p} ${e.d}`;
    case "context.compact": return `${p} ${e.before} -> ${e.after}`;
    case "plan.updated": return `${p} ${e.items.map((i) => `${i.status}:${i.text}`).join(" | ")}`;
    case "subagent.spawn": return `${p} ${e.id} ${JSON.stringify(e.task)}`;
    case "subagent.end": return `${p} ${e.id}`;
    case "steer": return `${p} from=${e.source} ${JSON.stringify(e.message)}`;
    case "memory.note": return `${p} ${e.scope}:${e.path}`;
    case "supervisor.signal": return `${p} ${e.signal.type} conf=${e.signal.confidence} ${e.signal.evidence.join("; ")}`;
    case "supervisor.intervention": return `${p} ${JSON.stringify(e.intervention)}`;
    case "error": return `${p} fatal=${e.fatal} ${e.message}`;
  }
}
