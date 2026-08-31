import type { HarnessEvent } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";
import { parseTestCounts } from "../test-output.js";

export interface StallOptions {
  /** Consecutive turns with no file change, varied tool input, new tool kind, or newly read path before it counts as a stall. */
  turns?: number;
  /** Consecutive test runs reporting an identical pass count before it counts as a stall. */
  testRuns?: number;
}

/**
 * PLAN §4.1: "N consecutive turns with no `file.changed` and no new tool kind; or ≥ k test runs
 * with unchanged pass count."
 *
 * A new tool kind is exploration, and a tool input that differs from the previous call is varied
 * activity: `git status` → `pnpm test` → `git diff` is verification, not spinning. A failed result
 * withdraws that call's variation credit, so alternating two failing commands is still a stall.
 * Bash exit-code transitions (red→green or green→red) are new information, and successful staging,
 * commit, push, and PR commands are shipping progress even when their input repeats. A familiar read
 * tool on an unfamiliar target is exploration too. `read_file`, `grep`, and `glob` therefore count
 * a path only once: walking through new files and
 * directories is orientation, while repeatedly reading or searching the same target can still
 * become a stall.
 *
 * A continuous condition emits once, then re-arms only after progress. Resetting the turn counter
 * immediately after a signal used to report the same unchanged stall every N turns and march the
 * policy ladder toward abort even though there was no new evidence to justify another intervention.
 *
 * The test-run branch only counts runs that are **still failing**, and resets whenever a file
 * changes. An unchanged pass count on a *green* suite is the success condition — re-verifying
 * that a refactor kept the suite green is the shape this would otherwise have called a stall.
 */
export function stallDetector(opts: StallOptions = {}): Detector {
  const turnLimit = opts.turns ?? 3;
  const runLimit = opts.testRuns ?? 3;

  const toolKinds = new Set<string>();
  const readTargets = new Set<string>();
  let quietTurns = 0;
  let changedThisTurn = false;
  let newKindThisTurn = false;
  let newReadThisTurn = false;
  let variedInputsThisTurn = 0;
  let verificationProgressThisTurn = false;
  let lastInputHash: string | null = null;
  const lastBashExitCode = new Map<string, number>();
  const pendingCalls = new Map<string, {
    name: string;
    inputHash: string;
    varied: boolean;
    command: string | null;
  }>();
  let reportedQuietStall = false;

  let lastCounts: string | null = null;
  let identicalRuns = 0;
  let reportedTestKey: string | null = null;

  const readTarget = (event: Extract<HarnessEvent, { type: "tool.call" }>): string | null => {
    if (event.name !== "read_file" && event.name !== "grep" && event.name !== "glob") return null;
    if (typeof event.input !== "object" || event.input === null || Array.isArray(event.input)) return null;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string") return event.name === "grep" || event.name === "glob" ? "." : null;
    // Calls spelling the same target as `./src/a.ts`, `src\\a.ts`, or `src/a.ts/` are repeats.
    return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  };

  const commandOf = (event: Extract<HarnessEvent, { type: "tool.call" }>): string | null => {
    if (event.name !== "bash" || typeof event.input !== "object" || event.input === null || Array.isArray(event.input)) {
      return null;
    }
    const command = (event.input as { command?: unknown }).command;
    return typeof command === "string" ? command : null;
  };

  const exitCodeOf = (event: Extract<HarnessEvent, { type: "tool.result" }>): number | null => {
    if (event.ok) return 0;
    const match = /\[exit code (-?\d+)\]/.exec(event.display);
    return match === null ? null : Number(match[1]);
  };

  const isShippingCommand = (command: string): boolean =>
    /(?:^|[;&|]\s*)(?:git\s+(?:add|commit|push)\b|gh\s+pr\s+(?:create|merge|ready|edit|comment)\b)/.test(command);

  return {
    id: "stall",
    observe(event: HarnessEvent, state: SupervisorState) {
      const from = state.recent[0]?.seq ?? event.seq;

      if (event.type === "file.changed") {
        changedThisTurn = true;
        reportedQuietStall = false;
        // work landed between two runs, so an identical count across them is not "stuck"
        identicalRuns = 0;
        lastCounts = null;
        reportedTestKey = null;
        return null;
      }

      if (event.type === "tool.call") {
        const varied = lastInputHash !== null && event.inputHash !== lastInputHash;
        if (varied) variedInputsThisTurn += 1;
        pendingCalls.set(event.id, {
          name: event.name,
          inputHash: event.inputHash,
          varied,
          command: commandOf(event),
        });
        while (pendingCalls.size > 400) pendingCalls.delete(pendingCalls.keys().next().value!);
        lastInputHash = event.inputHash;
        if (!toolKinds.has(event.name)) {
          toolKinds.add(event.name);
          newKindThisTurn = true;
          reportedQuietStall = false;
        }
        const target = readTarget(event);
        if (target !== null && !readTargets.has(target)) {
          readTargets.add(target);
          newReadThisTurn = true;
          reportedQuietStall = false;
        }
        return null;
      }

      if (event.type === "tool.result") {
        const pending = pendingCalls.get(event.id);
        if (pending !== undefined) {
          pendingCalls.delete(event.id);
          // Variation is exploratory until its result proves it was just another failed A/B
          // attempt. This preserves PR #36's varied-input activity without forgiving failure loops.
          if (!event.ok && pending.varied) variedInputsThisTurn = Math.max(0, variedInputsThisTurn - 1);
          if (pending.name === "bash") {
            const exitCode = exitCodeOf(event);
            if (exitCode !== null) {
              const previous = lastBashExitCode.get(pending.inputHash);
              // The same check crossing the red/green boundary is information. Distinct commands
              // and nonzero→nonzero alternation do not borrow transition credit from each other.
              if (previous !== undefined && (exitCode === 0) !== (previous === 0)) {
                verificationProgressThisTurn = true;
                reportedQuietStall = false;
              }
              lastBashExitCode.set(pending.inputHash, exitCode);
              while (lastBashExitCode.size > 400) lastBashExitCode.delete(lastBashExitCode.keys().next().value!);
            }
            if (event.ok && pending.command !== null && isShippingCommand(pending.command)) {
              verificationProgressThisTurn = true;
              reportedQuietStall = false;
            }
          }
        }

        const counts = parseTestCounts(event.display);
        if (counts === null) return null;
        if (counts.failed === 0) {
          // a green suite repeating its count is confirmation, not a stall
          identicalRuns = 0;
          lastCounts = null;
          reportedTestKey = null;
          return null;
        }
        const key = `${counts.passed}/${counts.failed}`;
        if (reportedTestKey === key) return null;
        if (reportedTestKey !== null) reportedTestKey = null;
        identicalRuns = key === lastCounts ? identicalRuns + 1 : 1;
        lastCounts = key;
        if (identicalRuns >= runLimit) {
          identicalRuns = 0;
          reportedTestKey = key;
          return signal("stall", 0.7, [
            `${runLimit} consecutive test runs reported the same ${counts.passed} passed / ${counts.failed} failed`,
            "the last few attempts moved nothing",
          ], [from, event.seq]);
        }
        return null;
      }

      if (event.type === "turn.end") {
        const productive = changedThisTurn || newKindThisTurn || newReadThisTurn ||
          variedInputsThisTurn > 0 || verificationProgressThisTurn;
        changedThisTurn = false;
        newKindThisTurn = false;
        newReadThisTurn = false;
        variedInputsThisTurn = 0;
        verificationProgressThisTurn = false;
        if (productive) {
          quietTurns = 0;
          reportedQuietStall = false;
        } else {
          quietTurns = Math.min(turnLimit, quietTurns + 1);
        }
        if (quietTurns >= turnLimit && !reportedQuietStall) {
          reportedQuietStall = true;
          return signal("stall", 0.65, [
            `${turnLimit} consecutive turns changed no file, varied no tool input, discovered no new read target, and used no new tool kind`,
            `${state.toolCalls} tool call(s) so far, ${state.filesChanged} file change(s)`,
          ], [from, event.seq]);
        }
      }

      return null;
    },
  };
}
