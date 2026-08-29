import type { HarnessEvent, PlanItem } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";

export interface DriftOptions {
  /** Out-of-scope files before it fires. 1 is right for a tight plan, higher for a loose one. */
  strays?: number;
}

/**
 * True when `path` sits inside `scope`. A scope entry is either an exact path or a directory
 * prefix — `src/` (or `src`) covers `src/a/b.ts`. Deliberately not globs: a plan that has to
 * write `**` to name a directory invites scopes so broad drift can never fire.
 */
export function inScope(path: string, scope: string[]): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const target = norm(path);
  return scope.some((entry) => {
    const s = norm(entry);
    return s === "" || target === s || target.startsWith(`${s}/`);
  });
}

/** Every scope declared by a plan item that is not dropped. */
export function declaredScope(plan: PlanItem[]): string[] {
  return plan.filter((i) => i.status !== "dropped").flatMap((i) => i.scope ?? []);
}

/**
 * PLAN §4.1: "files touched outside the plan's declared scope". v1 is exactly that comparison —
 * no model in the loop (the LLM-judged, sampled version is v2/M6).
 *
 * Silent when no plan item declares a scope, which is the common case: with nothing to drift
 * from, every file would be out of scope and the detector would fire on the first write. So this
 * one is opt-in by the agent's own plan rather than by config.
 */
export function driftDetector(opts: DriftOptions = {}): Detector {
  const strays = opts.strays ?? 1;
  const reported = new Set<string>();
  let pending: string[] = [];

  return {
    id: "drift",
    observe(event: HarnessEvent, state: SupervisorState) {
      if (event.type !== "file.changed") return null;
      const scope = declaredScope(state.plan);
      if (scope.length === 0) return null;
      if (inScope(event.path, scope) || reported.has(event.path)) return null;

      reported.add(event.path);
      pending.push(event.path);
      if (pending.length < strays) return null;

      const paths = pending;
      pending = [];
      return signal("drift", 0.6, [
        `changed ${paths.join(", ")}, which no plan item declares`,
        `declared scope: ${scope.join(", ")}`,
      ], [state.recent[0]?.seq ?? event.seq, event.seq]);
    },
  };
}
