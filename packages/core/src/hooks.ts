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
  /**
   * `post_tool`: what the tool returned. `display` is the string the model will see and the one
   * a `modify` patch replaces; `output` is the tool's own value, which is very often NOT a
   * string (bash returns `{exitCode, stdout, stderr}`, glob an array). Declaring `output: string`
   * meant a redaction hook written against the type crashed on `.replace` and was reported as a
   * generic hook failure — the worst outcome for a redaction hook.
   */
  result?: { ok: boolean; display: string; output: unknown };
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

/**
 * Hands a hook a *copy* of everything mutable it can see.
 *
 * Without this the whole validation story is theatre: `ctx.request.messages` IS the session's
 * live message array, so a handler returning `{action:"continue"}` — no patch, nothing to
 * validate — could push messages the model then saw, with zero events in the log. A `pre_compact`
 * hook, whose point accepts no `modify` at all, could empty the history and send the next request
 * with `messages: []`. Replaying the JSONL would reconstruct a conversation that never happened.
 *
 * A hook influences the session through its RETURN VALUE or not at all.
 */
function isolate(ctx: Omit<HookContext, "point">): Omit<HookContext, "point"> {
  const copy: Omit<HookContext, "point"> = { ...ctx };
  if (ctx.request !== undefined) {
    copy.request = { ...ctx.request, messages: cloneMessages(ctx.request.messages), tools: [...ctx.request.tools] };
  }
  if (ctx.messages !== undefined) copy.messages = cloneMessages(ctx.messages);
  if (ctx.response !== undefined) copy.response = cloneMessages([ctx.response])[0]!;
  if (ctx.tool !== undefined) copy.tool = { name: ctx.tool.name, input: structuredCloneSafe(ctx.tool.input) };
  if (ctx.result !== undefined) copy.result = { ...ctx.result };
  if (ctx.summary !== undefined) copy.summary = { ...ctx.summary, usage: { ...ctx.summary.usage } };
  return copy;
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((m) => ({ ...m, content: m.content.map((c) => ({ ...c })) }));
}

/** `structuredClone` throws on functions and class instances; a tool input that cannot be cloned
 *  is handed over as-is rather than failing the hook — it is already a plain parsed value in
 *  every builtin path. */
function structuredCloneSafe(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
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
  /** Aborting the session stops waiting on hooks; `ctx.signal` fires for cooperative handlers. */
  signal?: AbortSignal;
  /** Total wall clock for the whole chain, regardless of per-hook overrides. */
  totalTimeoutMs?: number;
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
  const startedAt = Date.now();

  for (const hook of opts.hooks) {
    if (hook.point !== point) continue;
    if (opts.signal?.aborted === true) {
      opts.onError(`hooks at ${point} stopped: the session was aborted`);
      break;
    }
    const name = hook.id ?? point;

    // The per-hook budget is the smaller of its own timeout and what is left of the chain's.
    // Without a total, `session_end` hooks with generous individual overrides (ingest 10m,
    // dream 15m) ran sequentially and could hold `session.done` for 25 minutes — "cannot hang
    // the session" was true of the loop's control flow but not of the session finishing.
    const own = hook.timeoutMs ?? timeoutMs;
    const remaining =
      opts.totalTimeoutMs === undefined ? own : Math.max(0, opts.totalTimeoutMs - (Date.now() - startedAt));
    const budget = Math.min(own, remaining);
    if (budget <= 0) {
      opts.onError(`hooks at ${point} stopped: the ${opts.totalTimeoutMs}ms budget for this point is spent`);
      break;
    }

    // a controller the handler can actually observe: it fires on the session abort AND on the
    // timeout, so a cooperative handler stops doing work rather than being merely abandoned
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let result: HookResult;
    try {
      result = await withTimeout(
        // isolated per hook, so one handler's mutations cannot even reach the next handler
        Promise.resolve(hook.handler({ ...isolate(ctx), point, signal: controller.signal })),
        budget,
        name,
        controller,
        opts.signal,
      );
    } catch (err) {
      // a third-party handler throwing or hanging must not take the session with it
      opts.onError(`hook ${name} failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
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

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  controller: AbortController,
  sessionSignal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onSessionAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // signal the handler as well as giving up on it: abandoning a promise leaves the work
          // running, so a cooperative handler needs to be told
          controller.abort();
          reject(new Error(`hook ${label} did not finish within ${ms}ms`));
        }, ms);
        timer.unref?.();
        if (sessionSignal !== undefined) {
          onSessionAbort = () => reject(new Error(`hook ${label} abandoned: the session was aborted`));
          if (sessionSignal.aborted) onSessionAbort();
          else sessionSignal.addEventListener("abort", onSessionAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onSessionAbort !== undefined) sessionSignal?.removeEventListener("abort", onSessionAbort);
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
