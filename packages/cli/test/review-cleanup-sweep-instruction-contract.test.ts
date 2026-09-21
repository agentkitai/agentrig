import { expect, it } from "vitest";
import { instructionSource } from "./instruction-source.js";
const read = (name: string) => instructionSource(`.agentrig/skills/${name}/SKILL.md`);
function cleanup(text: string) {
 const section = text.split("## Review scratch cleanup")[1]?.split("\n## ")[0] ?? "";
 for (const phrase of ["Join every job", "Verify", "Persist", "Remove", "git worktree prune", "author", "conductor-trio temporary root"]) expect(section).toContain(phrase);
 expect(section.indexOf("Join every job")).toBeLessThan(section.indexOf("Persist"));
 expect(section.indexOf("Persist")).toBeLessThan(section.indexOf("Remove"));
}
it("topic joins/restores/persists before scratch removal", () => cleanup(read("topic")));
for (const phrase of ["Join every job", "Persist", "git worktree prune", "conductor-trio temporary root"]) it(`M-cleanup-${phrase} deletion is rejected`, () => {
 const text = read("topic"); cleanup(text); expect(() => cleanup(text.replaceAll(phrase, "REMOVED"))).toThrow();
});
it("failed preparation cannot launch reviewers and persists receipt before cleanup", () => {
 const prepare = read("topic").split("- **Prepare.**")[1]?.split("- **Independent conductor checks")[0] ?? "";
 expect(prepare.replace(/\s+/g, " ")).toContain("If any preparation command fails, halt before any launch; persist the failure receipt, join all owned jobs and perform **Review scratch cleanup** before returning");
 expect(prepare).toContain("Empty steps run no commands");
 expect(prepare).toContain("does not satisfy any reviewer tree");
});
it("timeout and retry failure persist surviving reviews before cleanup", () => {
 const wait = read("topic").split("- **Wait.**")[1]?.split("- **Provenance.**")[0] ?? "";
 expect(wait).toContain("Kill jobs after 60 minutes");
 expect(wait.replace(/\s+/g, " ")).toContain("Retry ONCE on the same head, then halt");
 expect(wait).toContain("Persist surviving verdicts and failure receipts before cleanup");
});
it("verdict validation precedes receipt append and posting; only arguments substituted", () => {
 const section = read("topic").split("- **Provenance.**")[1]?.split("- **Combine.**")[0] ?? "";
 expect(section).toContain("Validate all reviewed SHA claims, including stripped headings, before appending receipts");
 expect(section).toContain("validateVerdict");
 expect(section).toContain("Replace only shell arguments");
 expect(section).toContain("do not rewrite validator source");
 expect(section).toContain("join every job".replace("j", "J"));
 expect(section).toContain("Unrestored mutants or unfinished writers invalidate the review");
 expect(section).toContain("no manual fallback");
});
