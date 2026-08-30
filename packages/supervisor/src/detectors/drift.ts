import type { HarnessEvent, PlanItem } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";

export interface DriftOptions {
  /** Caller-declared paths allowed independently of any scope declared by the plan. */
  scope?: string[];
  /** Build/test contract paths that must be explicitly included in scope before they may change. */
  contract?: string[];
  /** Out-of-scope files before it fires. 1 is right for a tight plan, higher for a loose one. */
  strays?: number;
  /** Distinct stray paths remembered, so a very long session stays bounded. */
  maxReported?: number;
}

/**
 * True when `path` sits inside `scope`. A scope entry is either an exact path or a directory
 * prefix — `src/` (or `src`) covers `src/a/b.ts`. Deliberately not globs: a plan that has to
 * write `**` to name a directory invites scopes so broad drift can never fire.
 *
 * Any entry that normalizes to nothing — `.`, `""`, `/`, `./` — means "the whole repo" and
 * matches everything. Getting this wrong is worse than it sounds: an earlier version left `"."`
 * as a literal segment, so the most natural way to declare a repo-wide scope made *every* file a
 * drift stray and walked the ladder to abort. `..` is resolved before comparing, so a path that
 * climbs out of the scope is not counted as inside it.
 */
function normalize(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const seg of slashed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return segments.join("/");
}

export function inScope(path: string, scope: string[]): boolean {
  const target = normalize(path);
  return scope.some((entry) => {
    const s = normalize(entry);
    // an entry that normalizes away (".", "", "/", "./") is repo-wide — NOT a scope that
    // matches nothing, which is the bug this replaced
    if (s === "") return true;
    return target === s || target.startsWith(`${s}/`);
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
 * Ordinary files are silent when neither the caller nor a plan item declares a scope: with nothing
 * to drift from, every file would be out of scope and the detector would fire on the first write.
 * Contract files are the exception because changing one changes what "passing" means; they stay
 * watched until a caller or plan scope explicitly includes them.
 */
const DEFAULT_CONTRACT = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "tsconfig.json",
  ".github",
];

export function driftDetector(opts: DriftOptions = {}): Detector {
  const strays = opts.strays ?? 1;
  const maxReported = opts.maxReported ?? 2048;
  const callerScope = opts.scope ?? [];
  const contract = opts.contract ?? DEFAULT_CONTRACT;
  const reported = new Set<string>();
  let pending: Array<{ path: string; seq: number; contract: boolean }> = [];

  return {
    id: "drift",
    observe(event: HarnessEvent, state: SupervisorState) {
      if (event.type !== "file.changed") return null;
      const scope = [...new Set([...callerScope, ...declaredScope(state.plan)])];
      const isContract = inScope(event.path, contract);
      if (inScope(event.path, scope) || reported.has(event.path)) return null;
      // Ordinary files cannot be called stray when there is no declared boundary. Contract files
      // are different: changing them changes what "passing" means, so they require explicit scope.
      if (scope.length === 0 && !isContract) return null;

      reported.add(event.path);
      // bounded: a session touching tens of thousands of files must not grow this forever
      while (reported.size > maxReported) {
        const oldest = reported.values().next();
        if (oldest.done === true) break;
        reported.delete(oldest.value);
      }
      pending.push({ path: event.path, seq: event.seq, contract: isContract });
      if (pending.length < strays) return null;

      const strayed = pending;
      pending = [];
      const contractPaths = strayed.filter((p) => p.contract).map((p) => p.path);
      const ordinaryPaths = strayed.filter((p) => !p.contract).map((p) => p.path);
      const evidence = [
        ...(contractPaths.length === 0
          ? []
          : [`changed ${contractPaths.join(", ")}, which is part of the project's build or test contract`]),
        ...(ordinaryPaths.length === 0
          ? []
          : [`changed ${ordinaryPaths.join(", ")}, which is outside the declared scope`]),
        `declared scope: ${scope.length === 0 ? "(none)" : scope.join(", ")}`,
      ];
      return signal("drift", 0.6, evidence, [strayed[0]!.seq, event.seq]);
    },
  };
}
