import { z } from "zod";
import type { Agent, AgentConfig, Budget, Pricing } from "../agent.js";
import type { AnyTool, ToolContext, ToolResult } from "../tool.js";

/**
 * A subagent tool. `subagent.spawn` / `subagent.end` have been in the event schema since M0 and
 * nothing ever emitted one — the same dormant contract `plan.updated` was before M6.
 *
 * The point of a subagent is **context isolation**, not parallelism: a search that would fill the
 * parent's window with fifty file contents happens in a session of its own, and the parent
 * receives only the answer. So the child's events go to the child's log, and the parent's log
 * records that a child ran and how it ended — enough to trace, not enough to drown.
 *
 * Two properties this tool must actually enforce, not merely claim:
 *
 * - **Spend is bounded.** A parent's budget cannot bind its children (they are separate sessions
 *   with separate meters), so the bound has to be built here: an explicit per-child budget, plus
 *   a per-parent-session pool of children, tokens and USD that every child is metered against.
 * - **Recursion terminates.** `depth` is threaded by this tool, not by its caller: the child's
 *   subagent tool is constructed here at `depth + 1`, and any subagent tool the caller's
 *   `childConfig()` supplies is dropped. A guard whose enforcement depends on the caller
 *   remembering to thread a counter is not a guard.
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
   * the parent's memory tools. Its `budget` is ignored (see `childBudget`) and any subagent
   * tool in its `tools` is replaced by one this tool builds at the next depth.
   */
  childConfig: () => AgentConfig;
  createAgent: (config: AgentConfig) => Agent;
  /** Turns before a child is cut off. Deliberately smaller than a parent's. */
  maxTurns?: number;
  /**
   * The rest of the child's budget, stated explicitly. Never spread from the parent's config:
   * spreading gives *every* child the parent's whole token/USD allowance, and omitting the
   * fields gives every child no allowance at all. Both were true of the first version.
   */
  childBudget?: Omit<Budget, "maxTurns">;
  /** Handed to the child so its `maxUsd` binds, and used to meter children against the pool. */
  pricing?: Pricing;
  /** Children one parent session may start. The count is the backstop when tokens are unmetered. */
  maxChildren?: number;
  /** Tokens all of one parent session's children may spend between them. */
  maxChildTokens?: number;
  /** USD all of one parent session's children may spend between them. Needs `pricing`. */
  maxChildUsd?: number;
  /**
   * How deep spawning may nest. 1 means a subagent cannot spawn its own. Unbounded recursion
   * here is a fork bomb with a token budget attached.
   */
  maxDepth?: number;
  depth?: number;
}

export const SUBAGENT_TOOL = "subagent";

interface Pool {
  children: number;
  tokens: number;
  usd: number;
}

/**
 * Per parent session, so a pool is not shared between two runs of the same agent. Sessions are
 * never announced as finished to a tool, so the map is bounded by eviction rather than by
 * cleanup — an entry is three numbers and the oldest is the least likely to still be running.
 */
const MAX_POOLS = 256;

function poolFor(pools: Map<string, Pool>, sessionId: string): Pool {
  let pool = pools.get(sessionId);
  if (pool === undefined) {
    pool = { children: 0, tokens: 0, usd: 0 };
    pools.set(sessionId, pool);
    while (pools.size > MAX_POOLS) {
      const oldest = pools.keys().next();
      if (oldest.done === true) break;
      pools.delete(oldest.value);
    }
  }
  return pool;
}

export function subagentTool(opts: SubagentOptions): AnyTool {
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? 1;
  const maxTurns = opts.maxTurns ?? 15;
  const maxChildren = opts.maxChildren ?? 8;
  const pools = new Map<string, Pool>();

  const refuse = (display: string): ToolResult<unknown> => ({
    output: { refused: true },
    display,
    isError: true,
  });

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
        return refuse(`subagents may not nest more than ${maxDepth} deep; do this task yourself`);
      }

      // the pool is checked BEFORE anything is created, so a refusal costs no session
      const pool = poolFor(pools, ctx.sessionId);
      if (pool.children >= maxChildren) {
        return refuse(
          `this session has already run ${pool.children} subagent(s), the limit; do the rest yourself`,
        );
      }
      if (opts.maxChildTokens !== undefined && pool.tokens >= opts.maxChildTokens) {
        return refuse(
          `subagents for this session have spent their token allowance (${opts.maxChildTokens}); do the rest yourself`,
        );
      }
      if (opts.maxChildUsd !== undefined && pool.usd >= opts.maxChildUsd) {
        return refuse(
          `subagents for this session have spent their USD allowance ($${opts.maxChildUsd}); do the rest yourself`,
        );
      }

      const config = opts.childConfig();
      // The child's own spawning ability is decided here, never by the caller: strip whatever
      // subagent tool `childConfig()` supplied (it carries the CURRENT depth) and, if another
      // level is allowed, add one that knows it is a level deeper.
      const childTools = config.tools.filter((t) => t.name !== SUBAGENT_TOOL);
      if (depth + 1 < maxDepth) childTools.push(subagentTool({ ...opts, depth: depth + 1 }));

      const budget: Budget = { ...(opts.childBudget ?? {}), maxTurns };
      const pricing = opts.pricing ?? config.pricing;
      const child = opts.createAgent({
        ...config,
        tools: childTools,
        // NOT `{...config.budget}`: a child inherits no allowance it was not explicitly given
        budget,
        ...(pricing === undefined ? {} : { pricing }),
      });

      // the parent's log records the child's existence before the child writes anything, so a
      // trace read in order never shows a session that came from nowhere
      const id = config.store.create();
      pool.children += 1;
      ctx.emit({ type: "subagent.spawn", id, task: input.label ?? input.task });

      const session = child.run(input.task, { cwd: ctx.cwd, id });

      let ended = false;
      const end = (reason: "done" | "aborted" | "error" | "budget"): void => {
        if (ended) return;
        ended = true;
        ctx.emit({ type: "subagent.end", id: session.id, reason });
      };

      // the parent's abort must reach the child, or aborting a session would leave its children
      // running and billing. `subagent.end` is emitted HERE rather than after the loop: by the
      // time the loop unwinds the parent is ending, and events from a finished session are
      // dropped — which is how a spawn came to be logged with no matching end.
      const onAbort = (): void => {
        session.control.abort();
        end("aborted");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      /** The last turn that actually said something. */
      let answer = "";
      /** The turn in progress. */
      let current = "";
      try {
        for await (const e of session.events) {
          // the child's transcript stays in the child's log: forwarding it would defeat the
          // context isolation that is the entire reason to spawn one
          if (e.type === "turn.start") current = "";
          else if (e.type === "model.delta") current += e.text;
          // a child that states its conclusion and THEN makes one more tool call is normal, and
          // no system prompt prevents it — so keep the last turn that had text, not the last turn
          else if (e.type === "turn.end" && current.trim() !== "") answer = current;
        }
        // an aborted or errored final turn never reaches `turn.end`
        if (current.trim() !== "") answer = current;

        const summary = await session.done;
        pool.tokens += summary.usage.input + summary.usage.output;
        if (pricing !== undefined) {
          pool.usd +=
            (summary.usage.input * pricing.inputUsdPerMTok +
              summary.usage.output * pricing.outputUsdPerMTok) /
            1e6;
        }
        end(summary.reason);

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
