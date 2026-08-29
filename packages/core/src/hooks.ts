import { z } from "zod";
import type { Message } from "./messages.js";
import type { ModelRequest } from "./provider.js";
import type { SessionSummary } from "./agent.js";

/**
 * PLAN §2.7. The extension seam: `memory`'s session-end extraction and `supervisor`'s steering
 * are both supposed to land through hooks rather than through special-casing in the loop.
 *
 * Three properties are load-bearing, all learned the hard way in M4–M6:
 *
 *  - **A hook cannot break the session.** Every handler is wrapped; a throw is recorded as a
 *    non-fatal `error` event and treated as `continue`. An extension point that can kill the
 *    thing it extends is worse than no extension point.
 *  - **A hook cannot hang the session.** Each handler is raced against a timeout. `session_end`
 *    hooks do real work (ingest, dream) and are the most likely to be slow.
 *  - **A hook's `modify` patch is validated before it is applied.** A handler is third-party
 *    code; trusting its patch shape would let one bad plugin corrupt a request or a log.
 */

export const HookPoint = z.enum([
  "user_prompt",
  "pre_model",
  "post_model",
  "pre_tool",
  "post_tool",
  "pre_compact",
  "session_end",
]);
export type HookPoint = z.infer<typeof HookPoint>;

export type HookResult =
  | { action: "continue" }
  | { action: "deny"; reason: string }
  | { action: "modify"; patch: unknown }
  | { action: "inject"; message: string };

/** What a handler is given, narrowed per point. Extra fields are added, never repurposed. */
export interface HookContext {
  point: HookPoint;
  sessionId: string;
  cwd: string;
  turn: number;
  /** `user_prompt`: the task or steer about to be added. */
  prompt?: string;
  /** `pre_model`: the request about to be sent. */
  request?: ModelRequest;
  /** `post_model`: the assistant message that came back. */
  response?: Message;
  /** `pre_tool` / `post_tool`: which tool, and its (parsed) input. */
  tool?: { name: string; input: unknown };
  /** `post_tool`: what the tool returned. */
  result?: { ok: boolean; output: string };
  /** `pre_compact`: the message list about to be compacted. */
  messages?: Message[];
  /** `session_end`: how the session finished. */
  summary?: SessionSummary;
  signal: AbortSignal;
}

export interface Hook {
  point: HookPoint;
  /** Identifies the hook in error reports; defaults to its point when absent. */
  id?: string;
  /** Per-hook override of the runner's default. */
  timeoutMs?: number;
  handler(ctx: HookContext): Promise<HookResult> | HookResult;
}

const CONTINUE: HookResult = { action: "continue" };

/** Only these actions mean anything at each point; anything else is reported and ignored. */
const ALLOWED: Record<HookPoint, ReadonlySet<HookResult["action"]>> = {
  user_prompt: new Set(["continue", "deny", "modify", "inject"]),
  pre_model: new Set(["continue", "deny", "modify"]),
  post_model: new Set(["continue", "inject"]),
  pre_tool: new Set(["continue", "deny", "modify"]),
  post_tool: new Set(["continue", "modify", "inject"]),
  pre_compact: new Set(["continue", "deny"]),
  session_end: new Set(["continue"]),
};

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export interface HookRunnerOptions {
  hooks: readonly Hook[];
  timeoutMs?: number;
  /** Where a hook's failure is reported. The loop passes an `error` event emitter. */
  onError: (message: string) => void;
}

/**
 * Runs every hook registered at `point`, in order.
 *
 * The first `deny` wins and stops the chain — a denial is a decision, and asking the remaining
 * hooks to weigh in on something already refused is meaningless. `modify` patches accumulate so
 * two hooks can each adjust a request. `inject` messages accumulate for the same reason.
 */
export async function runHooks(
  opts: HookRunnerOptions,
  point: HookPoint,
  ctx: Omit<HookContext, "point">,
): Promise<{ denied?: string; patches: unknown[]; injects: string[] }> {
  const patches: unknown[] = [];
  const injects: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  for (const hook of opts.hooks) {
    if (hook.point !== point) continue;
    const name = hook.id ?? point;
    let result: HookResult;
    try {
      result = await withTimeout(
        Promise.resolve(hook.handler({ ...ctx, point })),
        hook.timeoutMs ?? timeoutMs,
        name,
      );
    } catch (err) {
      // a third-party handler throwing or hanging must not take the session with it
      opts.onError(`hook ${name} failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (result === null || typeof result !== "object" || !("action" in result)) {
      opts.onError(`hook ${name} returned no action; ignoring`);
      continue;
    }
    if (!ALLOWED[point].has(result.action)) {
      opts.onError(`hook ${name} returned "${result.action}", which ${point} does not support; ignoring`);
      continue;
    }

    if (result.action === "deny") return { denied: result.reason, patches, injects };
    if (result.action === "modify") patches.push(result.patch);
    if (result.action === "inject") injects.push(result.message);
  }
  return { patches, injects };
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`hook ${label} did not finish within ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Applies `modify` patches to a tool's input. Patches are shallow-merged in order, and the
 * result is re-validated by the caller against the tool's own schema — a hook is third-party
 * code, so its patch is a proposal, not an instruction.
 */
export function mergePatches(base: unknown, patches: unknown[]): unknown {
  let out = base;
  for (const patch of patches) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) continue;
    if (out === null || typeof out !== "object" || Array.isArray(out)) {
      out = { ...(patch as Record<string, unknown>) };
      continue;
    }
    out = { ...(out as Record<string, unknown>), ...(patch as Record<string, unknown>) };
  }
  return out;
}
