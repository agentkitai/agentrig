import { z } from "zod";
import { usageTokens, usageUsd, type Agent, type AgentConfig, type Budget, type Pricing } from "../agent.js";
import type { Usage } from "../events.js";
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
  /**
   * @internal Threaded by the tool when it builds a child's own subagent tool. A grandchild's
   * spend is charged to every ancestor's pool, or the pool bounds one level and the tree grows
   * as `maxChildren ** maxDepth` with everything below the first level invisible.
   */
  ancestorPools?: Pool[];
}

export const SUBAGENT_TOOL = "subagent";

export interface Pool {
  /** Descendants, not just direct children: every ancestor is charged. */
  children: number;
  tokens: number;
  usd: number;
  /** Spawns currently running against this pool. An in-flight pool is never evicted. */
  live: number;
}

/**
 * Per parent session, so a pool is not shared between two runs of the same agent. Sessions are
 * never announced as finished to a tool, so the map is bounded by eviction rather than by cleanup:
 * least-recently-used, and never a pool with a child still running (whose completion would
 * otherwise charge an orphan, and whose session would be handed a fresh pool with its limits
 * back at zero).
 */
const MAX_POOLS = 256;

function poolFor(pools: Map<string, Pool>, sessionId: string): Pool {
  const existing = pools.get(sessionId);
  if (existing !== undefined) {
    // re-insert so eviction is by last use, not by first: the oldest INSERTED entry is the
    // longest-running session, which is the last one whose limits should be forgotten
    pools.delete(sessionId);
    pools.set(sessionId, existing);
    return existing;
  }
  const pool: Pool = { children: 0, tokens: 0, usd: 0, live: 0 };
  pools.set(sessionId, pool);
  while (pools.size > MAX_POOLS) {
    const idle = [...pools].find(([, p]) => p.live === 0);
    // every pool busy means the map is bounded by concurrency rather than by MAX_POOLS; that is
    // the safe direction — resetting a live session's limits is not
    if (idle === undefined) break;
    pools.delete(idle[0]);
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
      "Run a self-contained task in a separate child session and get back only its final answer. " +
      "This is THE way to run a child from here: it inherits this session's provider, permissions, " +
      "skills and tools, its start and end are recorded in this session's log, and the supervisor " +
      "knows it is running. Never launch a nested `agentrig run` from bash for that — it gets none " +
      "of this wiring and this session cannot see it. Use it both to keep bulk work out of this " +
      "conversation (a broad search, reading many files for one answer) and to delegate a whole " +
      "job to an isolated worker (implement something, review something). The subagent sees none " +
      "of this conversation, so the task must stand alone.",
    inputSchema: Input,
    // a subagent can do anything its tools can do, so it is at least as privileged as `exec`;
    // claiming less would let a `--allow read` run arbitrary writes through a child
    permission: "exec",
    execute: async (input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult<unknown>> => {
      if (depth >= maxDepth) {
        return refuse(`subagents may not nest more than ${maxDepth} deep; do this task yourself`);
      }

      // Every ancestor's pool, then this session's. A grandchild is a descendant of each of them
      // and is charged to all: with the pool held per level, `maxChildren` bounded a level rather
      // than a tree, and a grandchild's spend was invisible to the session that started it all.
      const chain = [...(opts.ancestorPools ?? []), poolFor(pools, ctx.sessionId)];
      // checked BEFORE anything is created, so a refusal costs no session
      for (const p of chain) {
        if (p.children >= maxChildren) {
          return refuse(
            `this session has already run ${p.children} subagent(s), the limit; do the rest yourself`,
          );
        }
        if (opts.maxChildTokens !== undefined && p.tokens >= opts.maxChildTokens) {
          return refuse(
            `subagents for this session have spent their token allowance (${opts.maxChildTokens}); do the rest yourself`,
          );
        }
        if (opts.maxChildUsd !== undefined && p.usd >= opts.maxChildUsd) {
          return refuse(
            `subagents for this session have spent their USD allowance ($${opts.maxChildUsd}); do the rest yourself`,
          );
        }
      }

      const config = opts.childConfig();
      // The child's own spawning ability is decided here, never by the caller: strip whatever
      // subagent tool `childConfig()` supplied (it carries the CURRENT depth) and, if another
      // level is allowed, add one that knows it is a level deeper.
      const childTools = config.tools.filter((t) => t.name !== SUBAGENT_TOOL);
      if (depth + 1 < maxDepth) {
        childTools.push(subagentTool({ ...opts, depth: depth + 1, ancestorPools: chain }));
      }

      const budget: Budget = { ...(opts.childBudget ?? {}), maxTurns };
      const pricing = opts.pricing ?? config.pricing;
      // A child's abort grace is half its parent's: abort reaches both on the same signal, so a
      // child waiting as long as its parent always finishes its log AFTER the parent gave up
      // waiting — and the parent would record a child "still running" that ends a moment later.
      const parentGrace = Number.isFinite(config.abortGraceMs) && (config.abortGraceMs as number) >= 0
        ? (config.abortGraceMs as number)
        : 1_000;
      const child = opts.createAgent({
        ...config,
        abortGraceMs: Math.floor(parentGrace / 2),
        tools: childTools,
        // NOT `{...config.budget}`: a child inherits no allowance it was not explicitly given
        budget,
        ...(pricing === undefined ? {} : { pricing }),
      });

      // the parent's log records the child's existence before the child writes anything, so a
      // trace read in order never shows a session that came from nowhere
      const id = config.store.create();
      // Charged at SPAWN time, not on completion: the loop runs tool calls sequentially today,
      // but `parallelTools` is advertised and this tool is public API — a gate that is read
      // before an await and written after it is not a gate. The child's own cap is the best
      // estimate available; the difference is reconciled when it finishes.
      const reservedTokens = budget.maxTokens ?? 0;
      const reservedUsd = budget.maxUsd ?? 0;
      for (const p of chain) {
        p.children += 1;
        p.tokens += reservedTokens;
        p.usd += reservedUsd;
        p.live += 1;
      }
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
      // A listener added to an already-aborted signal never fires. The parent can abort between
      // its top-of-loop check and this call (a pre_tool hook, a permission prompt), and a child
      // spawned into that window would otherwise run its full budget with nobody able to stop it.
      if (ctx.signal.aborted) onAbort();

      /**
       * Reconciles the reservation with what the child actually spent, once. Called with the
       * child's usage on the normal path and with none if it threw, where the reservation stands.
       */
      let settled = false;
      const settle = (usage?: Usage): void => {
        if (settled) return;
        settled = true;
        const spentTokens = usage === undefined ? reservedTokens : usageTokens(usage);
        const spentUsd =
          usage === undefined || pricing === undefined
            ? reservedUsd
            : usageUsd(
                usage,
                pricing,
                config.provider.capabilities.cacheReadDiscount,
                config.provider.capabilities.cacheWriteMultiplier,
              );
        for (const p of chain) {
          p.tokens += spentTokens - reservedTokens;
          p.usd += spentUsd - reservedUsd;
          p.live -= 1;
        }
      };

      /** The last turn that actually said something. */
      let answer = "";
      /** Whether that turn was the child's last: a preamble is not a conclusion. */
      let answerIsFinal = false;
      /** The turn in progress. */
      let current = "";
      try {
        for await (const e of session.events) {
          // the child's transcript stays in the child's log: forwarding it would defeat the
          // context isolation that is the entire reason to spawn one
          if (e.type === "turn.start") current = "";
          else if (e.type === "model.delta") current += e.text;
          // `turn.end` is emitted even when a turn is aborted or errors mid-tool, so every turn
          // that produced text is seen here — there is no trailing buffer left to promote
          else if (e.type === "turn.end") {
            // A child that states its conclusion and THEN makes one more tool call is normal, and
            // no system prompt prevents it — so the last turn that HAD text is the answer. But an
            // opening remark is also text, so when it was not the final turn, say so rather than
            // passing a preamble off as a conclusion.
            if (current.trim() !== "") {
              answer = current;
              answerIsFinal = true;
            } else if (answer !== "") {
              answerIsFinal = false;
            }
          }
        }
        const summary = await session.done;
        settle(summary.usage);
        end(summary.reason);

        const text = answer.trim();
        const answerText =
          answerIsFinal || text === ""
            ? text
            : `(the subagent's final turn carried no message; this was its last one)\n${text}`;
        const sessionLine = `subagent session ${session.id}`;
        if (summary.reason !== "done") {
          return {
            output: summary,
            display: `${sessionLine}\nsubagent ${summary.reason} after ${summary.turns} turn(s)${answerText === "" ? "" : `:\n${answerText}`}`,
            isError: true,
          };
        }
        return {
          output: summary,
          display: `${sessionLine}\n${answerText === "" ? "(the subagent finished without a final message)" : answerText}`,
        };
      } finally {
        // a throw anywhere above must still release the reservation, or one failed spawn would
        // leave a pool permanently `live` (never evictable) and permanently charged
        settle();
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  } as AnyTool;
}
