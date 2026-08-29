import { z } from "zod";
import type { HarnessEvent, ModelProvider } from "@agentkitai/agentrig-core";

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
  review(input: ReviewInput): Promise<ReviewOutput>;
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

export interface TrajectoryReviewerOptions {
  provider: ModelProvider;
  maxTokens?: number;
  maxEvents?: number;
  /** Bounds the whole prompt; a stuck session's trajectory grows without limit. */
  maxPromptChars?: number;
}

export class TrajectoryReviewer implements Reviewer {
  constructor(private readonly opts: TrajectoryReviewerOptions) {}

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const maxPromptChars = this.opts.maxPromptChars ?? 24_000;
    const trajectory = condenseTrajectory(input.trajectory, this.opts.maxEvents ?? 120);
    const parts = [
      `# Task\n${input.task}`,
      input.memoryIndex === undefined || input.memoryIndex === "" ? "" : `# What the agent knows\n${input.memoryIndex}`,
      `# Attempts ledger\n${renderAttempts(input.attempts ?? [])}`,
      `# Trajectory (most recent last)\n${trajectory}`,
    ].filter((p) => p !== "");
    let user = parts.join("\n\n");
    if (user.length > maxPromptChars) {
      // keep the TAIL: what the agent just did matters more than how it opened
      user = `…(earlier context truncated)\n${user.slice(user.length - maxPromptChars)}`;
    }

    const text = await complete(this.opts.provider, SYSTEM, user, this.opts.maxTokens ?? 1500);
    const parsed = ReviewSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      // a reviewer that cannot be parsed must not become a crash in the supervisor; the ladder
      // simply gets no useful guidance and moves on
      return {
        diagnosis: "the reviewer's response could not be parsed",
        directions: [],
        guidance: "",
      };
    }
    return parsed.data;
  }
}

/** One non-streaming completion. Duplicated rather than importing memory — supervisor must not depend on it. */
export async function complete(
  provider: ModelProvider,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  let text = "";
  for await (const ev of provider.stream(
    { system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], tools: [], maxTokens },
    new AbortController().signal,
  )) {
    if (ev.type === "text_delta") text += ev.text;
  }
  return text;
}

/** Tolerates fenced JSON; returns null rather than throwing, so a bad reply is never fatal. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
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
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
