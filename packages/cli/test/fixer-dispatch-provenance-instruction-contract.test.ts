import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

const read = (path: string) => readSkillText(path);
const dogfoodPath = ".agentrig/skills/dogfood/SKILL.md";
const shipPath = ".agentrig/skills/ship/SKILL.md";
const landPath = ".agentrig/skills/land/SKILL.md";
const policyPath = "docs/SHIPPING-WORKFLOW.md";
const statusPath = "docs/STATUS.md";

const dogfoodSentences = [
  "For a fixer, the durable pre-push GitHub PR handoff comment must quote verbatim the dispatched `Repair round: N/3` line, the dispatched `Pre-dispatch read-back` receipt, and every assigned finding's exact heading and source comment URL/anchor.",
  "The dispatch hook records the pre-edit live-review-versus-dispatch comparison, including each checked comment ID and the live PR head; fixers do not write a second comparison.",
  "Post and read back this handoff before every fixer push; a later handoff does not satisfy the pre-push gate.",
] as const;

const shipSentences = [
  "The trusted project extension `.agentrig/extensions/dispatch-record.mjs` records every subagent dispatch after a PR exists, including the exact complete task, dispatch time, current PR head SHA and parent session id.",
  "The hook posts the dispatch comment and verifies its API read-back byte-for-byte before allowing the tool call; any lookup, post or read-back failure denies dispatch clearly.",
  "Before a PR exists the hook leaves the initial builder invocation untouched; conductors do not manually post or read back dispatch-task comments.",
  "Match the hook comment to the immutable session-store `subagent.spawn` event by exact task text and parent session id; obtain the child session ID from that event, never by inventing it.",
  "Invoke the fixer subagent tool without its optional `label` field; because immutable `subagent.spawn.task` records `input.label ?? input.task`, only an unlabeled fixer invocation preserves the complete dispatched task for provenance matching.",
] as const;

const landSentences = [
  "For every dispatched fixer, require a conductor `gh pr view NN --json body` read-back receipt BEFORE the subagent call.",
  "Reject a missing read-back receipt or advisory-only dispatch as a contract violation; a counter repaired by the fixer afterwards cannot retroactively satisfy it.",
  "Read the PR body and match that line against the round, OLD and assigned blockers in the persisted fixer task; verify its timestamp precedes the dispatch.",
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
  "The fixer's durable pre-push handoff requires the dispatched round, persisted read-back receipt, each exact finding source, dispatch time and hook-recorded pre-edit comparison; it does not require the full dispatched task.",
  "The full dispatched task belongs in the hook's durable dispatch-time PR comment, which must match the immutable session-store `subagent.spawn` event by exact task text and parent session id; obtain the child session ID from that event.",
  "A missing durable fixer pre-push handoff alone is not a halt when that matched hook-comment-plus-spawn provenance exists.",
  "That matched pair is sufficient dispatch provenance, but it does not waive receipt-before-dispatch ordering, round/OLD/blocker identity, exact heading/source identity, or the hook-recorded pre-edit comparison with comment ID and head.",
  "If neither the durable fixer pre-push handoff nor that matched hook-comment-plus-spawn provenance exists, halt without retroactively manufacturing either record.",
] as const;

const policySentences = [
  "Require successful edit and read-back of that receipt before dispatch and quote it in the dispatched fixer task; the fixer separately quotes it in the pre-push handoff when that record survives.",
  "Land checks the same persisted receipt against the accepted dispatch-provenance source and requires its timestamp before dispatch; private notes or retroactive receipt creation do not satisfy the gate.",
  "The fixer must post and read back a durable pre-push GitHub PR handoff comment quoting verbatim its dispatched `Repair round: N/3` line, dispatched `Pre-dispatch read-back` receipt, every assigned exact finding heading and source comment URL/anchor, dispatch time, and a reference to the hook-recorded pre-edit comparison with each checked comment ID and PR head.",
  "The trusted project extension `.agentrig/extensions/dispatch-record.mjs` records every subagent dispatch after a PR exists, including the exact complete task, dispatch time, current PR head SHA and parent session id.",
  "The hook posts the dispatch comment and verifies its API read-back byte-for-byte before allowing the tool call; any lookup, post or read-back failure denies dispatch clearly.",
  "Before a PR exists the hook leaves the initial builder invocation untouched; conductors do not manually post or read back dispatch-task comments.",
  "The conductor must invoke the fixer subagent tool without its optional `label` field: immutable `subagent.spawn.task` records `input.label ?? input.task`, so only an unlabeled fixer invocation preserves the complete dispatched task for provenance matching.",
  "Land may accept the hook dispatch comment matched to the immutable session-store `subagent.spawn` event by exact task text and parent session id as sufficient dispatch provenance; obtain the child session ID from that event. A missing durable fixer pre-push handoff alone is not a halt; when neither source exists land halts, and all receipt ordering, round/OLD/blocker identity, exact heading/source identity, and durable pre-edit comparison checks still apply.",
] as const;

const squashSentences = [
  "The single sanctioned exception is a verbatim human authorization quote that itself contains such an identifier: preserve the quote unchanged, but never add model or agent authorship attribution.",
] as const;

const statusSentences = [
  "Fixers now publish the dispatched round, receipt, exact finding sources, dispatch time and pre-edit comparison before pushing; ship conductors independently persist exact task/session provenance, and land accepts the matched conductor comment plus immutable spawn while retaining every ordering, identity and pre-edit check.",
  "Fixer tool invocations omit the optional `label` so immutable `subagent.spawn.task` preserves the full task used for provenance matching.",
  "The squash rule's sole identifier exception preserves a verbatim human authorization quote without attributing commit authorship to a model or agent; repair round: 1/3, blocker X-F1 repaired pending focused review, and no roadmap completion is claimed.",
] as const;

function expectSentences(text: string, sentences: readonly string[]): void {
  for (const sentence of sentences) expect(text).toContain(sentence);
}

for (const [name, path, sentences] of [
  ["dogfood fixer handoff", dogfoodPath, dogfoodSentences],
  ["ship conductor dispatch", shipPath, shipSentences],
  ["land provenance fallback", landPath, landSentences],
  ["shared shipping policy", policyPath, policySentences],
  ["land squash exception", landPath, squashSentences],
  ["status record", statusPath, statusSentences],
] as const) {
  it(`${name} pins every new instruction sentence`, () => expectSentences(read(path), sentences));
  for (const sentence of sentences) {
    it(`${name} rejects deletion mutant: ${sentence.slice(0, 48)}`, () => {
      const text = read(path);
      expectSentences(text, sentences);
      expect(() => expectSentences(text.replace(sentence, "REMOVED"), sentences)).toThrow();
    });
  }
}

it("ship persists exact task text before the operative fixer invocation", () => {
  const text = read(shipPath);
  const gate = text.slice(text.indexOf("Before calling a fixer"), text.indexOf("- Spawn the fixer"));
  expectSentences(gate, shipSentences);
  expect(gate.indexOf(shipSentences[0])).toBeLessThan(gate.indexOf(shipSentences[2]));
});

const expectLandGate = (text: string): void => {
  const gate = text.slice(text.indexOf("For every dispatched fixer"), text.indexOf("## 2. Merge"));
  expectSentences(gate, landSentences);
  expect(gate).not.toContain("The fetched live PR comment listing need not be written to `comments.json`.");
};

it("land requires the conductor comment and immutable spawn together", () => {
  expectLandGate(read(landPath));
});

it.each([
  ["M-unfetched-attributed-claim", landSentences[3], landSentences[3].replace("fetch the live PR body and comments, then quote the exact fetched body or comment text", "inspect available context")],
  ["M-api-sha-requires-body-comment", landSentences[4], landSentences[4].replace("quote the exact response field and value from that fetched response", "quote matching PR body or comment text")],
  ["M-api-response-paraphrase", landSentences[4], landSentences[4].replace("exact response field and value", "API result summary")],
  ["M-local-sha-unrecorded-command", landSentences[5], landSentences[5].replace("record the exact command, require exit 0, and quote the exact stdout", "summarize the command result")],
  ["M-local-sha-allows-failed-command", landSentences[5], landSentences[5].replace("require exit 0", "accept any exit")],
  ["M-local-sha-waives-fetched-api", landSentences[6], landSentences[6].replace("cannot establish a fetched `headRefOid` or CI SHA", "establishes the fetched `headRefOid` and CI SHA")],
  ["M-local-sha-missing-output-continues", landSentences[6], landSentences[6].replace("halts", "may continue")],
  ["M-api-quote-waives-attributed-provenance", landSentences[7], landSentences[7].replace("does not replace", "replaces")],
  ["M-lander-citation-may-use-recall", landSentences[8], landSentences[8].replace("never supply one from memory or inference", "supply one from memory when plausible")],
  ["M-comments-json-omission", landSentences[9], landSentences[8]],
  ["M-comments-json-body-unbound", landSentences[10], landSentences[10].replace("from that same `comments.json` artifact", "from any available source")],
  ["M-pr-blamed-for-lander-introduced-id", landSentences[11], landSentences[11].replace("a lander error and never a PR defect", "a PR defect")],
  ["M-pr-anchor-recast-as-lander-error", landSentences[12], landSentences[12].replace("remains subject to the existing halt gate above", "is a lander error and not a halt")],
  ["M-fixer-handoff-full-task", landSentences[13], landSentences[13].replace("does not require the full dispatched task", "requires the full dispatched task")],
  ["M-conductor-task-not-spawn-matched", landSentences[14], landSentences[14].replace("must match the immutable session-store `subagent.spawn` event", "may omit the immutable spawn")],
  ["M-matched-pair-waives-gates", landSentences[16], landSentences[16].replace("but it does not waive", "and it waives")],
  ["M-single-missing-source-halts", landSentences[17], landSentences[17].replace("neither", "either")],
] as const)("land rejects named mutant %s", (_mutant, original, weakening) => {
  const text = read(landPath);
  expect(weakening).not.toBe(original);
  expect(() => expectLandGate(text.replace(original, weakening))).toThrow();
});

it("land rejects named mutant M-comments-json-contradiction", () => {
  const text = read(landPath);
  expectLandGate(text);
  const mutant = text.replace(landSentences[9], `${landSentences[9]}\nThe fetched live PR comment listing need not be written to \`comments.json\`.`);
  expect(() => expectLandGate(mutant)).toThrow();
});

it("squash exception permits only quoted human text, not agent authorship", () => {
  const text = read(landPath);
  expect(text).toContain("No model or agent authorship identifiers anywhere in the commit.");
  expectSentences(text, squashSentences);
  expect(() => expectSentences(text.replace("verbatim human authorization quote", "generated implementation note"), squashSentences)).toThrow();
  expect(() => expectSentences(text.replace("never add model or agent authorship attribution", "add agent authorship attribution"), squashSentences)).toThrow();
});

it("topic delegates dispatch records to the hook without replacing ledger receipts", () => {
  const text = readSkillText(".agentrig/skills/topic/SKILL.md");
  for (const sentence of shipSentences.slice(0, 4)) expect(text).toContain(sentence);
  expect(text).toContain("Keep the separate pre-dispatch PR-body receipt and repair ledger gates unchanged.");
});

const hookComparisonGate = (policy: string, land: string): void => {
  expect(policy).toContain("Before starting a fixer, the dispatch hook fetches the live PR head and each cited source");
  expect(policy).toContain("posts `Pre-edit comparison: PASS` (or FAIL with mismatches)");
  expect(policy).toContain("FAIL denies dispatch");
  expect(policy).toContain("This hook-recorded comparison replaces the handwritten fixer comparison");
  expect(land).toContain("`Pre-edit comparison: PASS` in the dispatch comment before the child starts");
};
it("land accepts the hook-recorded comparison instead of a handwritten fixer receipt", () => {
  hookComparisonGate(read(policyPath), read(landPath));
});
it("rejects M554-land-handwritten replacing hook PASS acceptance", () => {
  expect(() => hookComparisonGate(read(policyPath), read(landPath).replace("`Pre-edit comparison: PASS` in the dispatch comment before the child starts", "a handwritten fixer comparison"))).toThrow();
});

const headingIdentitySentences = [
  "Repair classification uses an operative standalone `Repair round: N/3` line, not inline mentions, blockquotes or fenced examples; malformed operative round lines fail closed.",
  "Finding identity comes from the source comment’s canonical structured verdict headings when present (decoded JSON strings), otherwise exact legacy source lines; Markdown, Unicode and heading whitespace remain exact.",
  "Tasks may use `Finding: <exact heading>`, `<ID> heading: <exact heading>` (including severity-tagless headings), or a raw heading followed by `Source: <comment URL>`.",
  "A source URL may follow a finding or precede a labeled group.",
  "Never strip heading bytes or use surrounding prose to override structured verdict identity.",
] as const;
for (const path of [shipPath, policyPath]) {
  it(`exact heading and operative repair contract: ${path}`, () => expectSentences(read(path), headingIdentitySentences));
  for (const sentence of headingIdentitySentences) {
    it(`rejects heading/repair contract deletion: ${path}: ${sentence.slice(0, 40)}`, () => {
      expect(() => expectSentences(read(path).replace(sentence, "REMOVED"), headingIdentitySentences)).toThrow();
    });
  }
}
