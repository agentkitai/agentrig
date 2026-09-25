import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

// Mechanical enforcement is covered by dispatch-record, ledger-integrity and
// merge-guard runtime suites, not positive assertions for retired manual prose.
const citations = [
  "Before making a landing-gate claim that attributes a comment ID, comment URL or SHA to the PR body or a comment, fetch the live PR body and comments, then quote the exact fetched body or comment text containing that identifier.",
  "For a landing-gate claim sourced from a fetched GitHub API response, including a `headRefOid` or CI SHA, quote the exact response field and value from that fetched response.",
  "For a landing-gate SHA claim sourced from local command output, including `git rev-parse` or a SHA-producing `git merge-base`, record the exact command, require exit 0, and quote the exact stdout containing the claimed full SHA.",
  "A local-command quotation cannot establish a fetched `headRefOid` or CI SHA and does not replace the exact fetched body or comment quotation required for an attributed provenance claim; a failed command or stdout that does not contain the claimed full SHA halts.",
  "An API-response quotation does not replace the exact fetched body or comment quotation required for an attributed provenance claim.",
  "Only cite a comment ID present in the session-fetched comment listing; never supply one from memory or inference.",
  "Write the fetched live PR comment listing to a session-owned `comments.json` and retain it through the landing gate; only cite a comment ID that is present in that artifact.",
  "For every cited comment ID, quote the exact corresponding fetched `body` field from that same `comments.json` artifact.",
  "A comment ID the lander introduces that is absent from that listing, or a 404 for such an ID that cannot be traced to the fetched data, is a lander error and never a PR defect.",
  "A PR-supplied finding source URL or anchor that is absent, edited or mismatched remains subject to the existing halt gate above; never recast it as a lander-introduced citation error.",
] as const;
it("land retains fetched-evidence citation integrity", () => {
  const text = readSkillText(".agentrig/skills/land/SKILL.md");
  for (const sentence of citations) expect(text).toContain(sentence);
});

const retired = [
  "Fixer precondition (include verbatim in every fixer task): Before editing, fetch",
  "Match the hook comment to the immutable session-store",
  "save the stdout manifest in the PR",
  "Fetch every source comment live again and compare its heading with all three copies",
  "Invoke every subagent without its optional `label` field",
  "Before dispatch, before fixer edits and before landing fetch the live comments",
  "Fetch all source comments live and compare exact bytes",
  "recheck task-to-PR merge authorization and exact-head CI",
];
for (const name of ["dogfood", "ship", "topic", "land", "review"]) {
  it(`${name} does not ask for hook-owned manual bookkeeping`, () => {
    const text = readSkillText(`.agentrig/skills/${name}/SKILL.md`);
    for (const sentence of retired) expect(text).not.toContain(sentence);
  });
}
it("policy assigns mechanisms without surrendering land judgments", () => {
  const text = readSkillText("docs/SHIPPING-WORKFLOW.md");
  for (const sentence of retired) expect(text).not.toContain(sentence);
  expect(text).toContain("pre_spawn hook owns the exact-task dispatch record");
  expect(text).toContain("receipt ordering, mergeability, completion markers and post-merge CI remain land judgments");
});
it("land retains review-resolution judgment beyond the three mechanical checks", () => {
  const text = readSkillText(".agentrig/skills/land/SKILL.md");
  expect(text).toContain("owns three mechanical checks");
  expect(text).toContain("It does not judge review resolution");
  expect(text).toContain("Unresolved blockers always prevent landing");
  expect(text).toContain("Review coverage, dispositions and receipt-before-");
  expect(text).toContain("--match-head-commit FULL_HEAD");
});
