import { z } from "zod";
import type { HarnessEvent, ModelProvider } from "@agentkitai/agentrig-core";
import { AuxiliaryRun, auxiliaryDiagnostic, positiveLimit, type AuxiliaryOptions } from "./auxiliary.js";

/**
 * PLAN §4.3. The reviewer is the AVO piece: read the *whole trajectory* plus the attempts ledger
 * (which AVO lacked), diagnose what is actually going wrong, and propose several candidate
 * directions rather than one.
 *
 * Several directions is the substantive part. A supervisor that hands back a single instruction
 * has replaced the agent's judgement with its own on one sample; handing back candidates keeps
 * the decision where the context is, and makes the guidance falsifiable — an agent can look at
 * three options and recognise that none of them fit.
 */

export interface Attempt {
  id: string;
  sessionId: string;
  ts: number;
  hypothesis: string;
  actions: string;
  outcome: "success" | "failed" | "abandoned" | "reverted";
  evidence: string[];
  lesson?: string;
}

export interface ReviewInput {
  task: string;
  trajectory: HarnessEvent[];
  attempts?: Attempt[];
  /** Optional wiki digest — anything with an `index()`; kept structural so supervisor stays type-only on memory. */
  memoryIndex?: string;
}

export interface ReviewOutput {
  diagnosis: string;
  directions: string[];
  guidance: string;
}

export interface Reviewer {
  review(input: ReviewInput, opts?: AuxiliaryOptions): Promise<ReviewOutput>;
}

export const ReviewSchema = z.object({
  diagnosis: z.string(),
  directions: z.array(z.string()).default([]),
  guidance: z.string(),
});

const SYSTEM = `You are a supervisor reviewing an autonomous coding agent that appears to be stuck.

You are shown the task, a condensed trajectory of what the agent did, and its attempts ledger —
hypotheses it tried and how each turned out. Diagnose the ACTUAL problem, not the surface symptom.

Rules:
- The symptom is rarely the cause. "The same test keeps failing" is a symptom; "it is editing the
  wrong file" or "its mental model of the API is wrong" is a diagnosis.
- Propose 2-4 genuinely DIFFERENT candidate directions, not one idea reworded. If one is clearly
  best, say so in the guidance and still list the alternatives.
- Read the attempts ledger before proposing anything: re-suggesting something already recorded as
  failed is the single least useful thing you can do here.
- If the agent is actually fine and the detector misfired, say that plainly in the diagnosis and
  make the guidance "continue as you were".
- Guidance is addressed TO the agent, in the second person, and is at most a short paragraph.

Reply with ONLY this JSON:
{"diagnosis":"...","directions":["...","..."],"guidance":"..."}`;

/** Renders a trajectory compactly: the loop's own events are far too verbose to send whole. */
export function condenseTrajectory(events: HarnessEvent[], maxEvents = 120): string {
  const kept = events.slice(-maxEvents);
  const lines: string[] = [];
  for (const e of kept) {
    switch (e.type) {
      case "turn.start":
        lines.push(`--- turn ${e.n}`);
        break;
      case "tool.call":
        lines.push(`call ${e.name} ${JSON.stringify(e.input).slice(0, 200)}`);
        break;
      case "tool.result":
        lines.push(`  -> ${e.ok ? "ok" : "ERROR"} ${e.display.replace(/\s+/g, " ").slice(0, 240)}`);
        break;
      case "tool.denied":
        lines.push(`  -> DENIED ${e.name}`);
        break;
      case "file.changed":
        lines.push(`  changed ${e.path} (${e.op})`);
        break;
      case "plan.updated":
        lines.push(`plan: ${e.items.map((i) => `[${i.status}] ${i.text}`).join(" | ")}`);
        break;
      case "steer":
        lines.push(`steer(${e.source}): ${e.message.slice(0, 200)}`);
        break;
      case "supervisor.signal":
        lines.push(`signal ${e.signal.type}: ${e.signal.evidence.join("; ").slice(0, 200)}`);
        break;
      case "error":
        lines.push(`error: ${e.message.slice(0, 200)}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

export function renderAttempts(attempts: Attempt[], max = 40): string {
  if (attempts.length === 0) return "(no attempts recorded)";
  return attempts
    .slice(-max)
    .map((a) => {
      const lesson = a.lesson === undefined || a.lesson === "" ? "" : `\n  lesson: ${a.lesson}`;
      return `- [${a.outcome}] ${a.hypothesis}\n  did: ${a.actions.slice(0, 200)}${lesson}`;
    })
    .join("\n");
}

export interface TrajectoryReviewerOptions extends AuxiliaryOptions {
  provider: ModelProvider;
  maxTokens?: number;
  maxEvents?: number;
  /** Bounds the whole prompt; a stuck session's trajectory grows without limit. */
  maxPromptChars?: number;
}

export class TrajectoryReviewer implements Reviewer {
  constructor(private readonly opts: TrajectoryReviewerOptions) {}

  async review(input: ReviewInput, opts: AuxiliaryOptions = {}): Promise<ReviewOutput> {
    const signals = [opts.signal, this.opts.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const run = new AuxiliaryRun("reviewer", { ...this.opts.limits, ...opts.limits }, signals.length === 0 ? undefined : AbortSignal.any(signals),
      report => { auxiliaryDiagnostic(() => this.opts.onProgress?.(structuredClone(report))); auxiliaryDiagnostic(() => opts.onProgress?.(structuredClone(report))); });
    let failure: unknown;
    try {
      run.check();
      const maxPromptChars = this.opts.maxPromptChars ?? 24_000;
      positiveLimit("maxPromptChars", maxPromptChars);
      positiveLimit("maxEvents", this.opts.maxEvents ?? 120);
      const trajectory = condenseTrajectory(input.trajectory, this.opts.maxEvents ?? 120);
      const parts = [
        `# Task\n${input.task}`,
        input.memoryIndex === undefined || input.memoryIndex === "" ? "" : `# What the agent knows\n${input.memoryIndex}`,
        `# Attempts ledger\n${renderAttempts(input.attempts ?? [])}`,
        `# Trajectory (most recent last)\n${trajectory}`,
      ].filter((p) => p !== "");
      let user = parts.join("\n\n");
      if (user.length > maxPromptChars) {
        // keep the TAIL: what the agent just did matters more than how it opened. The marker
        // counts against the budget, or `maxPromptChars` would not actually bound the prompt.
        const marker = "…(earlier context truncated)\n";
        let cut = user.length - Math.max(0, maxPromptChars - marker.length);
        // never cut between a surrogate pair
        const code = user.charCodeAt(cut);
        if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
        user = maxPromptChars < marker.length ? marker.slice(0, maxPromptChars) : `${marker}${user.slice(cut)}`;
      }

      const text = await run.completeJson(this.opts.provider, SYSTEM, user, this.opts.maxTokens ?? 1500, { requireEndTurn: true });
      const parsed = lastValid(text, (v) => ReviewSchema.safeParse(v));
      if (parsed === null) {
        // a reviewer that cannot be parsed must not become a crash in the supervisor; the ladder
        // simply gets no useful guidance and moves on
        return {
          diagnosis: "the reviewer's response could not be parsed",
          directions: [],
          guidance: "",
        };
      }
      return parsed;
    } catch (error) { failure = error ?? new Error(String(error)); throw error; }
    finally {
      const report = run.finish(failure);
      auxiliaryDiagnostic(() => this.opts.onUsage?.(structuredClone(report)));
      auxiliaryDiagnostic(() => opts.onUsage?.(structuredClone(report)));
    }
  }
}

/** One non-streaming completion. Duplicated rather than importing memory — supervisor must not depend on it. */
export async function complete(
  provider: ModelProvider,
  system: string,
  user: string,
  maxTokens: number,
  opts: AuxiliaryOptions = {},
): Promise<string> {
  const run = new AuxiliaryRun("reviewer", opts.limits, opts.signal, opts.onProgress);
  let failure: unknown;
  try { return await run.completeJson(provider, system, user, maxTokens, { requireEndTurn: true }); }
  catch (error) { failure = error ?? new Error(String(error)); throw error; }
  finally { const report = run.finish(failure); auxiliaryDiagnostic(() => opts.onUsage?.(report)); }
}

/**
 * Tolerates fenced JSON; returns null rather than throwing, so a bad reply is never fatal.
 *
 * Scans **top-level** values and returns them all, in order. Returning at the first balanced
 * value — which an earlier version did — loses to two shapes a model produces constantly:
 * `Note [see below]. {"pass":false}` (the prose bracket is consumed, `JSON.parse` fails, the
 * whole reply is discarded) and `Use {} for defaults.\n{"pass":false}` (the empty object wins).
 *
 * `memory/src/ingest.ts` has a sibling implementation; the repo rule forbidding
 * `supervisor → memory` justifies duplicating the code, not diverging from it. Keep them in
 * step.
 */
export function extractJsonCandidates(text: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const out: unknown[] = [];

  /** Index just past a balanced JSON value starting at `from`, or -1. */
  const balancedEnd = (from: number): number => {
    const open = candidate[from];
    const close = open === "{" ? "}" : open === "[" ? "]" : "";
    if (close === "") return -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < candidate.length; i += 1) {
      const ch = candidate[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };

  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = balancedEnd(i);
    if (end === -1) continue;
    try {
      out.push(JSON.parse(candidate.slice(i, end)));
    } catch {
      // not valid JSON after all; fall through and keep scanning
    }
    // skip past this value: a nested object must not be considered a top-level candidate
    i = end - 1;
  }
  return out;
}

/** The first top-level value, for callers that just want "the JSON in this reply". */
export function extractJson(text: string): unknown {
  return extractJsonCandidates(text)[0] ?? null;
}

/**
 * The **last** candidate that satisfies `schema`. Last, not first, because a model that echoes
 * the format (`Format: {"pass":true,...}`) or thinks aloud before committing puts its real answer
 * at the end — and taking the first meant a grader returned the echoed `pass: true` and silently
 * certified the work. That is the exact failure PLAN §4.3 calls worse than no grader at all.
 */
export function lastValid<T>(text: string, parse: (v: unknown) => { success: true; data: T } | { success: false }): T | null {
  const candidates = extractJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const r = parse(candidates[i]);
    if (r.success) return r.data;
  }
  return null;
}
