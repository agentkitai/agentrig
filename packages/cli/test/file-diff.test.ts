import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDiff } from "@agentkitai/agentrig-core";
import { renderFileDiff } from "../src/file-diff.js";

function observed(before: string, after: string): FileDiff {
  return { path: "src/a.ts", scope: "observed", before: { text: before, status: "complete" },
    after: { text: after, status: "complete" } };
}
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

afterEach(() => vi.unstubAllEnvs());

describe("captured file diff presentation", () => {
  it("renders real changed lines, hunk coordinates and three lines of context", () => {
    const input = observed("a\nb\nc\nd\ne\nf\ng\nh\ni\n", "a\nb\nc\nd\nNEW\nf\ng\nh\ni\n");
    const out = renderFileDiff(input);
    expect(out).toContain("[observed before/after]");
    expect(out).toContain("@@ -2,7 +2,7 @@");
    expect(out).toContain("-e\n+NEW");
    expect(out).not.toContain("\n a\n");
    expect(out).not.toContain("\n i");
    expect(input.before.text).toContain("e\n");
  });

  it("keeps CRLF visible without emitting carriage-return terminal controls", () => {
    const out = renderFileDiff(observed("old\r\n", "new\r\n"));
    expect(out).toContain("-old␍");
    expect(out).toContain("+new␍");
    expect(out).not.toContain("\r");
  });

  it("distinguishes observed creation, empty no-change and proposed replacement", () => {
    expect(renderFileDiff(observed("", "created\n"))).toContain("+created");
    expect(renderFileDiff(observed("", ""))).toContain("no textual change");
    const proposal = observed("old", "new");
    proposal.scope = "proposed-replacement";
    expect(renderFileDiff(proposal)).toContain("proposed replacement excerpt (not whole file)");
  });

  it("never fabricates deletion/creation from unknown or truncated sides", () => {
    const diff = observed("UNTRUSTED_UNKNOWN_SENTINEL", "new\n");
    diff.scope = "proposed-content";
    diff.before.status = "unknown";
    let out = renderFileDiff(diff);
    expect(out).toContain("proposed content (not an observed write)");
    expect(out).toContain("contents unknown");
    expect(out).not.toContain("UNTRUSTED_UNKNOWN_SENTINEL");
    expect(out).not.toContain("@@");
    diff.before = { status: "truncated", text: "captured prefix" };
    out = renderFileDiff(diff);
    expect(out).toContain("before excerpt [truncated]");
    expect(out).toContain("captured prefix");
    expect(out).not.toContain("@@");
  });

  it("bounds a 5,000-line comparison and explicitly labels high-complexity fallback", () => {
    const out = renderFileDiff(observed(Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n"),
      Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n")));
    expect(out).toContain("Comparison limit reached");
    expect(out).toContain("before excerpt [complete]");
    expect(out).toContain("after excerpt [complete]");
    expect(out).toContain("excerpt elided");
    expect(out).not.toContain("@@");
    expect(out.split("\n").length).toBeLessThanOrEqual(80);
  });

  it("caps a valid large patch at 80 lines including an explicit elision", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line${i}\n`);
    const after = before.map((s, i) => i % 10 === 0 ? `changed${i}\n` : s);
    const out = renderFileDiff(observed(before.join(""), after.join("")));
    expect(out).toContain("@@");
    expect(out).toContain("diff output elided");
    expect(out.split("\n")).toHaveLength(80);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(48 * 1024);
  });

  it("sanitizes source controls, bidi and paths; only fixed ANSI can be emitted", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const diff = observed("\u001b[2J\u0007\u202eevil\n", "\u009b31m\u2066new\n");
    diff.path = "bad\n\u001b]0;title\u0007\u2028path";
    const colored = renderFileDiff(diff, { color: true });
    expect(colored).toContain("\u001b[31m");
    expect(colored).toContain("\u001b[32m");
    expect(colored).toContain("\u001b[36m");
    expect(plain(colored)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
    expect(renderFileDiff(diff)).not.toContain("\u001b");
    vi.stubEnv("NO_COLOR", "");
    expect(renderFileDiff(diff, { color: true })).not.toContain("\u001b");
  });

  it("caps printable code points and UTF-8 bytes even with wide source characters and color", () => {
    vi.stubEnv("NO_COLOR", undefined);
    const diff = observed("", Array.from({ length: 100 }, (_, i) => `${i}${"😀".repeat(600)}`).join("\n"));
    const out = renderFileDiff(diff, { color: true });
    expect(out).toContain("diff output elided");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(48 * 1024);
    expect(out.split("\n").length).toBeLessThanOrEqual(80);
    for (const line of plain(out).split("\n")) expect([...line].length).toBeLessThanOrEqual(512);
  });
});
