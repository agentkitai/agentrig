import { z } from "zod";
import type { HarnessEvent, ModelProvider } from "@agentkitai/agentrig-core";
import { complete, condenseTrajectory, extractJson } from "./reviewer.js";

/**
 * PLAN §4.3. The grader is the Outcomes piece: a written rubric checked by a *separate*
 * evaluator, standing in for the objective score AVO had.
 *
 * "Separate" is the whole value. The agent that did the work is the worst possible judge of
 * whether it did the work — it has every reason to read its own output charitably. A grader that
 * sees the rubric and the artifacts, but not the agent's reasoning about them, can say no.
 */

export interface FileRef {
  path: string;
  /** Contents, if the caller could read them. Absent means "this file was named but not read". */
  content?: string;
}

export interface GradeInput {
  rubric: string;
  artifacts: FileRef[];
  trajectory: HarnessEvent[];
}

export interface GradeOutput {
  pass: boolean;
  gaps: string[];
}

export interface Grader {
  grade(input: GradeInput): Promise<GradeOutput>;
}

export const GradeSchema = z.object({
  pass: z.boolean(),
  gaps: z.array(z.string()).default([]),
});

const SYSTEM = `You are grading an autonomous coding agent's work against a written rubric.

You are shown the rubric, the files the agent produced or changed, and a condensed trajectory.
Decide whether the work meets the rubric.

Rules:
- Grade the ARTIFACTS, not the narration. If the trajectory claims something the files do not
  show, that is a gap, not a pass.
- "pass": true only when every rubric requirement is met. Partial credit is a fail with gaps.
- Each gap names one specific unmet requirement, concretely enough to act on. Do not restate the
  rubric back as a gap.
- If the rubric cannot be evaluated from what you were shown, fail and say exactly what is missing.
- Absence of evidence is not evidence of completion: a file you were not shown cannot be assumed
  correct.

Reply with ONLY this JSON: {"pass":true|false,"gaps":["...","..."]}`;

export interface RubricGraderOptions {
  provider: ModelProvider;
  maxTokens?: number;
  /** Characters of artifact content sent. */
  maxArtifactChars?: number;
  maxEvents?: number;
}

export class RubricGrader implements Grader {
  constructor(private readonly opts: RubricGraderOptions) {}

  async grade(input: GradeInput): Promise<GradeOutput> {
    const budgetTotal = this.opts.maxArtifactChars ?? 20_000;
    let budget = budgetTotal;
    const rendered: string[] = [];
    for (const a of input.artifacts) {
      if (a.content === undefined) {
        rendered.push(`--- ${a.path}\n(not read)`);
        continue;
      }
      const block = `--- ${a.path}\n${a.content}`;
      if (block.length > budget) {
        rendered.push(`${block.slice(0, Math.max(0, budget))}\n…(truncated)`);
        break;
      }
      rendered.push(block);
      budget -= block.length;
    }

    const user = [
      `# Rubric\n${input.rubric}`,
      `# Artifacts\n${rendered.length === 0 ? "(none provided)" : rendered.join("\n\n")}`,
      `# Trajectory\n${condenseTrajectory(input.trajectory, this.opts.maxEvents ?? 60)}`,
    ].join("\n\n");

    const text = await complete(this.opts.provider, SYSTEM, user, this.opts.maxTokens ?? 1000);
    const parsed = GradeSchema.safeParse(extractJson(text));
    if (!parsed.success) {
      // An unparseable grader must fail closed. Defaulting to pass would mean a broken grader
      // silently certifies everything, which is worse than having no grader at all.
      return { pass: false, gaps: ["the grader's response could not be parsed"] };
    }
    return parsed.data;
  }
}
