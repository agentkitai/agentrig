import { z } from "zod";
import type { Agent, AgentConfig } from "../agent.js";
import type { AnyTool, ToolContext, ToolResult } from "../tool.js";

/**
 * A subagent tool. `subagent.spawn` / `subagent.end` have been in the event schema since M0 and
 * nothing ever emitted one — the same dormant contract `plan.updated` was before M6.
 *
 * The point of a subagent is **context isolation**, not parallelism: a search that would fill the
 * parent's window with fifty file contents happens in a session of its own, and the parent
 * receives only the answer. So the child's events go to the child's log, and the parent's log
 * records that a child ran and how it ended — enough to trace, not enough to drown.
 */

const Input = z.object({
  task: z
    .string()
    .min(1)
    .describe("a complete, self-contained instruction — the subagent sees none of this conversation"),
  /** Named so a trajectory reads sensibly; the model picks something short. */
  label: z.string().max(60).optional().describe("a few words naming what this subagent is for"),
});

export interface SubagentOptions {
  /**
   * Builds the child's config from the parent's. Injected rather than derived so the caller
   * decides what a child inherits — the harness must not guess that a child should get, say,
   * the parent's memory tools.
   */
  childConfig: () => AgentConfig;
  createAgent: (config: AgentConfig) => Agent;
  /** Turns before a child is cut off. Deliberately smaller than a parent's. */
  maxTurns?: number;
  /**
   * How deep spawning may nest. 1 means a subagent cannot spawn its own. Unbounded recursion
   * here is a fork bomb with a token budget attached.
   */
  maxDepth?: number;
  depth?: number;
}

export const SUBAGENT_TOOL = "subagent";

export function subagentTool(opts: SubagentOptions): AnyTool {
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? 1;
  const maxTurns = opts.maxTurns ?? 15;

  return {
    name: SUBAGENT_TOOL,
    description:
      "Run a self-contained task in a separate agent with its own context, and get back only its " +
      "final answer. Use this for work that would otherwise fill this conversation with detail " +
      "you do not need to keep — a broad search, reading many files to answer one question. " +
      "The subagent sees none of this conversation, so the task must stand alone.",
    inputSchema: Input,
    // a subagent can do anything its tools can do, so it is at least as privileged as `exec`;
    // claiming less would let a `--allow read` run arbitrary writes through a child
    permission: "exec",
    execute: async (input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      if (depth >= maxDepth) {
        return {
          output: { refused: true },
          display: `subagents may not nest more than ${maxDepth} deep; do this task yourself`,
          isError: true,
        };
      }

      const config = opts.childConfig();
      const child = opts.createAgent({
        ...config,
        budget: { ...(config.budget ?? {}), maxTurns },
      });

      const session = child.run(input.task, { cwd: ctx.cwd });
      ctx.emit({ type: "subagent.spawn", id: session.id, task: input.label ?? input.task });

      // the parent's abort must reach the child, or aborting a session would leave its children
      // running and billing
      const onAbort = (): void => session.control.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      let answer = "";
      try {
        for await (const e of session.events) {
          // the child's transcript stays in the child's log: forwarding it would defeat the
          // context isolation that is the entire reason to spawn one
          if (e.type === "model.delta") answer += e.text;
          if (e.type === "turn.start") answer = "";
        }
        const summary = await session.done;
        ctx.emit({ type: "subagent.end", id: session.id, reason: summary.reason });

        const text = answer.trim();
        if (summary.reason !== "done") {
          return {
            output: summary,
            display: `subagent ${summary.reason} after ${summary.turns} turn(s)${text === "" ? "" : `:\n${text}`}`,
            isError: true,
          };
        }
        return {
          output: summary,
          display: text === "" ? "(the subagent finished without a final message)" : text,
        };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  } as AnyTool;
}
