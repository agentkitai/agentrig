import type { HarnessEvent, PlanItem } from "@agentkitai/agentrig-core";
import { initialPlanEvidence, reducePlanEvidence, type PlanItemEvidence } from "./plan-evidence.js";

export const MAX_EVIDENCE_EVENTS = 100_000;
const MAX_REPORT_CHARS = 12_000;
const MAX_GAPS = 32;
export interface EvidenceReport {
  readonly text: string;
  readonly gaps: readonly string[];
  readonly hasDeclarations: boolean;
  readonly incomplete: boolean;
  readonly finished: boolean;
}

/** Streaming bounded state, shared by the grader and read-only finished-session report. */
export function evidenceReportCollector(options: { scope?: "current-run" } = {}) {
  const ledger = initialPlanEvidence();
  let statuses: PlanItem["status"][] = [];
  let hasDeclarations = false;
  let count = 0;
  let omittedEvents = 0;
  let sessionId: string | undefined;
  let invalidOrder = false;
  let previousSeq = -1;
  let finished = false;
  let startSeq: number | undefined;
  return {
    observe(event: HarnessEvent): void {
      if (++count > MAX_EVIDENCE_EVENTS) { omittedEvents++; finished = false; return; }
      if (count === 1) {
        startSeq = event.seq;
        // Only attach selects current-run scope. Resume/fork has a legitimate nonzero anchor;
        // arbitrary direct trajectory prefixes must still be reported as incomplete.
        if (options.scope === "current-run" && (event.type === "session.start" || event.type === "session.resume")) previousSeq = event.seq - 1;
      }
      sessionId ??= event.sessionId;
      if (event.sessionId !== sessionId || event.seq !== previousSeq + 1) invalidOrder = true;
      if (event.sessionId !== sessionId || event.seq <= previousSeq) return;
      previousSeq = event.seq;
      finished = event.type === "session.end";
      if (event.type === "plan.updated") {
        statuses = event.items.slice(0, 100).map(item => item.status);
        hasDeclarations = event.items.some(item => item.accept !== undefined);
      }
      reducePlanEvidence(ledger, event);
    },
    omitEvents(amount: number): void { omittedEvents += amount; finished = false; },
    report(): EvidenceReport {
      const gaps: string[] = [];
      let omittedGaps = 0;
      const gap = (text: string) => {
        if (gaps.length < MAX_GAPS) gaps.push(text);
        else omittedGaps++;
      };
      const lines = ["Claims → evidence (candidate observations; semantic acceptance remains unverified)",
        options.scope === "current-run" ? `Scope: current run from event#${startSeq ?? "unknown"}; prior history not assessed.` :
          "Scope: supplied physical-session history; fork ancestors are not assessed.",
        "item | plan status | declared check | latest candidate | observation refs"];
      let chars = lines.join("\n").length;
      let omittedRows = 0;
      for (let index = 0; index < ledger.items.length; index++) {
        const item = ledger.items[index]!;
        const status = statuses[index] ?? "pending";
        const latest = item.attempts.at(-1);
        const observation = latest?.observation ?? "unknown";
        let description = observation === "exit-match" ? "matching exit candidate (not proof)" :
          observation === "exit-mismatch" ? "unverified: latest exit mismatch" : `unverified: ${latest?.reason ?? item.reason}`;
        if (status === "dropped") description = "dropped; not a required completion claim";
        else if (status !== "done") description = `unverified: unfinished (${status}); ${description}`;
        if (item.accept !== undefined && status !== "dropped") {
          if (status !== "done") gap(`acceptance ${label(item)}: unfinished plan item (${status})`);
          else if (observation !== "exit-match") gap(`acceptance ${label(item)}: ${description}`);
        }
        const refs = latest === undefined ? "none" : `call#${latest.callSeq}${latest.resultSeq === undefined ? "; no result" : ` → result#${latest.resultSeq}`}`;
        const line = `${JSON.stringify(item.id)} ${JSON.stringify(item.text)} | ${status} | ${JSON.stringify(item.accept ?? "undeclared")} | ${description} | ${refs}`;
        // Reserve room for a truthful omission summary; never partially display an acceptance check.
        if (chars + line.length + 1 > MAX_REPORT_CHARS - 512) { omittedRows++; continue; }
        lines.push(line); chars += line.length + 1;
      }
      const incomplete = ledger.incomplete || omittedEvents > 0 || invalidOrder || omittedRows > 0;
      if (incomplete) {
        const summary = `unverified: incomplete evidence view (omitted rows ${omittedRows + ledger.omittedItems}; omitted attempts ${ledger.items.reduce((n, item) => n + item.omittedAttempts, 0)}; omitted events ${omittedEvents}; invalid ordering ${invalidOrder})`;
        lines.push(summary);
        gap(summary);
      }
      if (omittedGaps > 0) gaps.push(`unverified: ${omittedGaps} further acceptance gaps omitted`);
      if (ledger.items.length === 0) lines.push("(no current plan declarations observed; not evidence of completion)");
      return Object.freeze({ text: lines.join("\n"), gaps: Object.freeze(gaps), hasDeclarations, incomplete, finished: finished && !invalidOrder && omittedEvents === 0 });
    },
  };
}

function label(item: PlanItemEvidence): string {
  // JSON quoting keeps terminal/control text inert; bounded labels leave space for useful reasons.
  return JSON.stringify(item.id.length <= 96 ? item.id : `${item.id.slice(0, 95)}…`);
}

export function reportEvidence(trajectory: readonly HarnessEvent[]): EvidenceReport {
  const collector = evidenceReportCollector();
  for (const event of trajectory.slice(0, MAX_EVIDENCE_EVENTS)) collector.observe(event);
  if (trajectory.length > MAX_EVIDENCE_EVENTS) collector.omitEvents(trajectory.length - MAX_EVIDENCE_EVENTS);
  return collector.report();
}
