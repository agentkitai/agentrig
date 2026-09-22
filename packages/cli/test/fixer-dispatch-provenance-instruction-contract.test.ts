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
  "It must also record the dispatch time and the fixer's pre-edit live-review-versus-ledger comparison result, including each checked comment ID and the PR head.",
  "Post and read back this handoff before every fixer push; a later handoff does not satisfy the pre-push gate.",
] as const;

const shipSentences = [
  "Immediately before invoking the fixer subagent, post and read back a durable GitHub PR comment containing the exact complete fixer task text and dispatch time; this dispatch comment must exist independently of fixer survival.",
  "If the subagent tool exposes the child session ID synchronously, include it in that comment before invocation.",
  "If the ID is available only when the synchronous tool call returns, write `child session id: pending tool result` in the dispatch comment, then immediately edit that comment or reply to it with the actual child session ID when the call returns; never invent an ID or delay the task-text comment until child completion.",
  "If the call fails after dispatch or returns without an ID, read the immutable session-store `subagent.spawn` event and update the comment with its actual child session ID before proceeding; absence of both an exposed ID and a matching spawn event halts.",
  "Invoke the fixer subagent tool without its optional `label` field; because immutable `subagent.spawn.task` records `input.label ?? input.task`, only an unlabeled fixer invocation preserves the complete dispatched task for provenance matching.",
] as const;

const landSentences = [
  "For every dispatched fixer, require a conductor `gh pr view NN --json body` read-back receipt BEFORE the subagent call.",
  "Reject a missing read-back receipt or advisory-only dispatch as a contract violation; a counter repaired by the fixer afterwards cannot retroactively satisfy it.",
  "Read the PR body and match that line against the round, OLD and assigned blockers in the persisted fixer task; verify its timestamp precedes the dispatch.",
  "A missing fixer handoff alone is not a halt when the conductor's dispatch-time PR comment is matched to an immutable session-store `subagent.spawn` event carrying the same exact task text and child session ID.",
  "That matched pair is sufficient dispatch provenance, but it does not waive receipt-before-dispatch ordering, round/OLD/blocker identity, exact heading/source identity, or the fixer's durable pre-edit comparison with comment ID and head.",
  "If neither the fixer handoff nor that matched conductor-comment-plus-spawn provenance exists, halt without retroactively manufacturing either record.",
] as const;

const policySentences = [
  "Require successful edit and read-back of that receipt before dispatch and quote it in the dispatched fixer task; the fixer separately quotes it in the pre-push handoff when that record survives.",
  "Land checks the same persisted receipt against the accepted dispatch-provenance source and requires its timestamp before dispatch; private notes or retroactive receipt creation do not satisfy the gate.",
  "The fixer must post and read back a durable pre-push GitHub PR handoff comment quoting verbatim its dispatched `Repair round: N/3` line, dispatched `Pre-dispatch read-back` receipt, every assigned exact finding heading and source comment URL/anchor, dispatch time, and pre-edit live-review-versus-ledger comparison result with each checked comment ID and PR head.",
  "Immediately before fixer invocation, the conductor must post and read back a durable PR comment with the exact complete dispatched task text and dispatch time, independently of fixer survival.",
  "Include the child session ID before invocation when exposed synchronously; otherwise record `child session id: pending tool result` and immediately edit or reply with the actual ID when the synchronous call returns, without delaying the task-text comment or inventing an ID.",
  "If the call fails after dispatch or returns without an ID, the conductor must read the immutable session-store `subagent.spawn` event and update the comment with its actual child session ID before proceeding; absence of both an exposed ID and a matching spawn event halts.",
  "The conductor must invoke the fixer subagent tool without its optional `label` field: immutable `subagent.spawn.task` records `input.label ?? input.task`, so only an unlabeled fixer invocation preserves the complete dispatched task for provenance matching.",
  "Land may accept that conductor comment matched to the immutable session-store `subagent.spawn` event's exact task text and child session ID as sufficient dispatch provenance, so a missing fixer handoff alone is not a halt; when neither source exists land halts, and all receipt ordering, round/OLD/blocker identity, exact heading/source identity, and durable pre-edit comparison checks still apply.",
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

it("land requires the conductor comment and immutable spawn together", () => {
  const text = read(landPath);
  const gate = text.slice(text.indexOf("For every dispatched fixer"), text.indexOf("## 2. Merge"));
  expectSentences(gate, landSentences);
  for (const [original, weakening] of [
    [landSentences[3], landSentences[3].replace(" is matched to an immutable session-store `subagent.spawn` event", " exists")],
    [landSentences[4], landSentences[4].replace("but it does not waive", "and it waives")],
    [landSentences[5], landSentences[5].replace("neither", "either")],
  ] as const) {
    expect(weakening).not.toBe(original);
    expect(() => expectSentences(text.replace(original, weakening), landSentences)).toThrow();
  }
});

it("squash exception permits only quoted human text, not agent authorship", () => {
  const text = read(landPath);
  expect(text).toContain("No model or agent authorship identifiers anywhere in the commit.");
  expectSentences(text, squashSentences);
  expect(() => expectSentences(text.replace("verbatim human authorization quote", "generated implementation note"), squashSentences)).toThrow();
  expect(() => expectSentences(text.replace("never add model or agent authorship attribution", "add agent authorship attribution"), squashSentences)).toThrow();
});
