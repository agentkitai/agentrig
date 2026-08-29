/**
 * Pass/fail counts scraped out of a tool result's `display`. PLAN §4.1 asks two detectors
 * (`stall`, `test_regression`) to reason about "pass count", which no event carries — the only
 * place it exists is the text a test runner printed into a bash result.
 *
 * This is deliberately a heuristic over the handful of runners we actually see, not a parser.
 * An unrecognized format returns null, and every detector treats null as "this was not a test
 * run" rather than as zero — a misread that invented a 0 would fire `test_regression` on every
 * `ls`.
 */
export interface TestCounts {
  passed: number;
  failed: number;
}

/**
 * Ordered most-specific first: vitest and jest summary lines mention both counts, so they must
 * be tried before the looser "N passed" forms that would match only half of the line.
 */
const PATTERNS: Array<(text: string) => TestCounts | null> = [
  // vitest: "Tests  1 failed | 259 passed (260)" / "Tests  260 passed (260)"
  (t) => {
    const m = /^[ \t]*Tests[ \t]+(.+)$/m.exec(t);
    if (m === null) return null;
    const line = m[1]!;
    const passed = /(\d+)\s+passed/.exec(line);
    const failed = /(\d+)\s+failed/.exec(line);
    if (passed === null && failed === null) return null;
    return { passed: passed === null ? 0 : Number(passed[1]), failed: failed === null ? 0 : Number(failed[1]) };
  },
  // jest: "Tests:       2 failed, 5 passed, 7 total"
  (t) => {
    const m = /^[ \t]*Tests:[ \t]+(.+)$/m.exec(t);
    if (m === null) return null;
    const line = m[1]!;
    const passed = /(\d+)\s+passed/.exec(line);
    const failed = /(\d+)\s+failed/.exec(line);
    if (passed === null && failed === null) return null;
    return { passed: passed === null ? 0 : Number(passed[1]), failed: failed === null ? 0 : Number(failed[1]) };
  },
  // pytest: "===== 5 passed, 2 failed in 0.12s =====" (either half may be absent)
  (t) => {
    const passed = /(\d+)\s+passed/.exec(t);
    const failed = /(\d+)\s+failed/.exec(t);
    if (passed === null && failed === null) return null;
    return { passed: passed === null ? 0 : Number(passed[1]), failed: failed === null ? 0 : Number(failed[1]) };
  },
  // mocha: "5 passing" / "2 failing"
  (t) => {
    const passed = /(\d+)\s+passing/.exec(t);
    const failed = /(\d+)\s+failing/.exec(t);
    if (passed === null && failed === null) return null;
    return { passed: passed === null ? 0 : Number(passed[1]), failed: failed === null ? 0 : Number(failed[1]) };
  },
  // go test: count the per-test verdict lines
  (t) => {
    const passed = (t.match(/^--- PASS:/gm) ?? []).length;
    const failed = (t.match(/^--- FAIL:/gm) ?? []).length;
    return passed + failed === 0 ? null : { passed, failed };
  },
];

export function parseTestCounts(display: string): TestCounts | null {
  for (const p of PATTERNS) {
    const counts = p(display);
    if (counts !== null && Number.isFinite(counts.passed) && Number.isFinite(counts.failed)) return counts;
  }
  return null;
}
