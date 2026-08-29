/**
 * Pass/fail counts scraped out of a tool result's `display`. PLAN §4.1 asks two detectors
 * (`stall`, `test_regression`) to reason about "pass count", which no event carries — the only
 * place it exists is the text a test runner printed into a bash result.
 *
 * Every pattern must be **anchored on something only a test runner prints**. An earlier version
 * scanned for a bare `/(\d+)\s+passed/` anywhere in the output and defaulted the missing half to
 * zero; `rsync: 3 failed to transfer` then read as a completed run with *zero passes*, which
 * `test_regression` scored as losing the entire suite and the ladder escalated to abort. So:
 * a half-match on unanchored prose must return null, never a zero.
 */
export interface TestCounts {
  passed: number;
  failed: number;
  /** passed + failed. `test_regression` uses it to tell a subset run from a real regression. */
  total: number;
}

function counts(passed: number, failed: number): TestCounts | null {
  if (!Number.isFinite(passed) || !Number.isFinite(failed)) return null;
  return { passed, failed, total: passed + failed };
}

/** Reads "N passed" / "N failed" out of one already-identified summary line. */
function fromSummaryLine(line: string): TestCounts | null {
  const passed = /(\d+)\s+(?:passed|passing|ok\b)/.exec(line);
  const failed = /(\d+)\s+(?:failed|failing)/.exec(line);
  if (passed === null && failed === null) return null;
  // safe to default the absent half here: the line was identified as a runner summary, and
  // "260 passed (260)" genuinely means zero failures
  return counts(passed === null ? 0 : Number(passed[1]), failed === null ? 0 : Number(failed[1]));
}

/**
 * Ordered most-specific first. Order is load-bearing where two anchors could both match one
 * line, and `test-output.test.ts` pins it: moving the looser patterns forward has to break a test.
 */
const PATTERNS: Array<(text: string) => TestCounts | null> = [
  // vitest: "Tests  1 failed | 259 passed (260)" / "Tests  260 passed (260)"
  (t) => {
    const m = /^[ \t]*Tests[ \t]+([^\n]+)$/m.exec(t);
    return m === null ? null : fromSummaryLine(m[1]!);
  },
  // jest: "Tests:       2 failed, 5 passed, 7 total"
  (t) => {
    const m = /^[ \t]*Tests:[ \t]+([^\n]+)$/m.exec(t);
    return m === null ? null : fromSummaryLine(m[1]!);
  },
  // cargo: "test result: ok. 5 passed; 0 failed; 1 ignored"
  (t) => {
    const m = /^[ \t]*test result:[ \t]*([^\n]+)$/m.exec(t);
    return m === null ? null : fromSummaryLine(m[1]!);
  },
  // pytest: "===== 5 passed, 2 failed in 0.12s =====" — anchored on the `=` rule it always prints
  (t) => {
    const m = /^=+[ \t]*([^\n=]*\b(?:passed|failed)\b[^\n=]*)=*$/m.exec(t);
    return m === null ? null : fromSummaryLine(m[1]!);
  },
  // mocha: a count at the start of its own line, "  5 passing (12ms)" / "  2 failing"
  (t) => {
    const passing = /^[ \t]*(\d+)[ \t]+passing\b/m.exec(t);
    const failing = /^[ \t]*(\d+)[ \t]+failing\b/m.exec(t);
    if (passing === null && failing === null) return null;
    return counts(passing === null ? 0 : Number(passing[1]), failing === null ? 0 : Number(failing[1]));
  },
  // go test: count the per-test verdict lines
  (t) => {
    const passed = (t.match(/^--- PASS:/gm) ?? []).length;
    const failed = (t.match(/^--- FAIL:/gm) ?? []).length;
    return passed + failed === 0 ? null : counts(passed, failed);
  },
];

/** Null means "this was not a test run" — never treat it as zero passes. */
export function parseTestCounts(display: string): TestCounts | null {
  for (const p of PATTERNS) {
    const c = p(display);
    if (c !== null) return c;
  }
  return null;
}
