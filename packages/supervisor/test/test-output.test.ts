import { describe, expect, it } from "vitest";
import { parseTestCounts } from "@agentkitai/agentrig-supervisor";

describe("parseTestCounts", () => {
  it("reads vitest, jest, cargo, pytest, mocha and go", () => {
    expect(parseTestCounts("Tests  1 failed | 259 passed (260)")).toEqual({ passed: 259, failed: 1, total: 260 });
    expect(parseTestCounts(" Tests  260 passed (260)")).toEqual({ passed: 260, failed: 0, total: 260 });
    expect(parseTestCounts("Tests:       2 failed, 5 passed, 7 total")).toEqual({ passed: 5, failed: 2, total: 7 });
    expect(parseTestCounts("test result: ok. 5 passed; 0 failed; 1 ignored")).toEqual({
      passed: 5,
      failed: 0,
      total: 5,
    });
    expect(parseTestCounts("===== 5 passed, 2 failed in 0.12s =====")).toEqual({ passed: 5, failed: 2, total: 7 });
    expect(parseTestCounts("  5 passing (12ms)\n  2 failing")).toEqual({ passed: 5, failed: 2, total: 7 });
    expect(parseTestCounts("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- PASS: TestC")).toEqual({
      passed: 2,
      failed: 1,
      total: 3,
    });
  });

  it("returns null for output that is not a test run", () => {
    expect(parseTestCounts("total 48\ndrwxr-xr-x 3 user user 4096 src")).toBeNull();
    expect(parseTestCounts("")).toBeNull();
    expect(parseTestCounts("Compiled 12 modules in 300ms")).toBeNull();
  });

  it("never invents a zero pass count from prose that merely says 'failed'", () => {
    // this is the critical one: an unanchored matcher read each of these as a completed run with
    // ZERO passes, which test_regression scored as losing the whole suite and the ladder
    // escalated to abort. Half a match must be no match.
    for (const prose of [
      "rsync: 3 failed to transfer",
      "Deleted 4 branches, 1 failed",
      "warning: 2 failed downloads, retrying",
      "error: 1 failed precondition",
      "fatal: 12 failed to push some refs",
    ]) {
      expect(parseTestCounts(prose)).toBeNull();
    }
  });

  it("does not raise a high-water mark from prose that merely says 'passed'", () => {
    for (const prose of [
      "note: 12 passed the checkpoint",
      "3 passed through the proxy",
      "deploy: 40 passed validation",
    ]) {
      expect(parseTestCounts(prose)).toBeNull();
    }
  });

  it("pattern order is load-bearing: the most specific anchor wins", () => {
    // a vitest run whose captured output also contains go-style verdict lines must be read by
    // the vitest summary, not by the go counter. If the looser patterns were tried first this
    // would come back as {passed:1,failed:1}.
    const mixed = "--- PASS: TestA\n--- FAIL: TestB\nTests  1 failed | 259 passed (260)";
    expect(parseTestCounts(mixed)).toEqual({ passed: 259, failed: 1, total: 260 });

    // and a jest summary must not be read by the pytest `=` anchor around it
    const framed = "===============================\nTests:       2 failed, 5 passed, 7 total";
    expect(parseTestCounts(framed)).toEqual({ passed: 5, failed: 2, total: 7 });
  });

  it("reports total so a caller can tell a subset run from a shrinking suite", () => {
    expect(parseTestCounts("Tests  120 passed (120)")!.total).toBe(120);
    expect(parseTestCounts("Tests  7 failed | 320 passed (327)")!.total).toBe(327);
  });
});
