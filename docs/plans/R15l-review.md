# R15l — original independent review

One read-only Claude review of frozen `0a69a1bc78408f0f2b356551bc2fff4173016f77`
against `887fef8`. Requested 16 turns; reported **28**, exceeding the requested cap.
Session `1a8187b5-22e2-442e-9079-918ed5df57a5`, 124.333 seconds, exit 0;
reported model `claude-fable-5-1`, no denied tools or spawned agents.
Reported list-price estimate USD 1.45220475 is metadata, not subscription billing.
The reviewer inspected source and documentation, not runtime tests or external CI.
No second review. Original final response follows verbatim.

**Verdict: APPROVE.** The R15l change is coherent and honestly bounded. Every evidence claim in the decision that I could check against the repository matches the shipped exports and the actual isolated-subagent test file. I found no material contradiction, no authority bypass in the guidance, no false evidence claim, and the decision itself is explicit.

**Files and controls inspected** (read-only, no tests run, no network):

- `docs/plans/R15l.md` in full, plus the R15l text in `docs/ROADMAP.md` at lines 3, 259, 800, 884 to 889, 951 and 1263, `docs/STATUS.md` lines 3, 35 and 40 to 48, and `docs/PLAN.md` lines 245 to 269.
- `docs/plans/R10c.md` in full. Confirmed `docs/plans/R10c-review.md` exists so the link resolves.
- `packages/core/src/index.ts`, `packages/core/src/tools/index.ts` line 40, `packages/core/src/turn-strategy.ts` lines 16 to 36, `packages/core/src/tools/subagent.ts` lines 86 to 87 and 169, `packages/core/src/tool.ts` line 75.
- `packages/core/test/isolated-subagents.test.ts` in full.

**Numbered findings** (all confirmations, none blocking):

1. **Export claims are accurate.** `parallel({ maxConcurrency })` exists at `packages/core/src/turn-strategy.ts:34` and is re-exported from the public entry point. `subagentTool({ isolation: "worktree" })` exists at `packages/core/src/tools/subagent.ts:87` and reaches the public surface through the tools barrel. The `.execute()` method the guidance warns against bypassing is the real tool contract at `packages/core/src/tool.ts:75`.

2. **Two-writer test claims match the test body.** R15l.md lines 75 to 78 attribute five properties to the two-writer test. All five are present in `packages/core/test/isolated-subagents.test.ts:66-113`: distinct worktrees and dirty/untracked preservation at lines 72 to 74, reversed completion with model-order results at lines 76 to 82, deny then explicit allow through normal agent dispatch at lines 102 to 106, and conflicting second patch rejection at line 111.

3. **Separate-control claims match.** Stale-parent refusal is at line 200, abort artifact retention at line 208, no remapped grants at line 115, parent sandbox refusal at line 192, and the ordinary-tool barrier at line 176. The decision does not over-claim: it notes at line 80 that these support architecture, not task quality, which matches the timing-sensitive caveat the test itself records at lines 181 to 182.

4. **Renunciation 8 remains coherent.** The renunciation at `docs/ROADMAP.md:884` targets adopting a distributed durable engine. The added clarification at lines 888 to 889 permits only a host program over existing seams and explicitly excludes a loader, DAG scheduler, automatic merge and new durability guarantee. That is a narrowing of what users may rely on, not a widening of runtime capability.

5. **No authority bypass in guidance.** R15l.md item 2 states that direct `.execute()` calls are not an authorization path and that a trusted host script already has ambient host authority. PLAN.md lines 265 to 266 say the same. This is honest about the limit rather than pretending the SDK confines its own caller, and it matches R10c's stated cooperative-isolation limits at `docs/plans/R10c.md:42-46`.

6. **Guarantees are correctly renounced.** Non-atomic check/apply, no exactly-once resume, no automatic conflict resolution, no spend ceiling and no measured quality benefit are each stated in R15l.md lines 44 to 60 and repeated in the ROADMAP row. Nothing in the three roadmap documents claims otherwise.

7. **Decision is present and traceable.** R15l.md line 24 states the decision. All three of ROADMAP, PLAN and STATUS were updated as the contract at line 13 requires. The optional runnable example at `docs/ROADMAP.md:1263` is correctly placed at roadmap end and R15l.md line 65 says the decision does not depend on it.

8. **Ordering is defensible.** ROADMAP section 5 lists R15l as order 15 after R15h to R15k, yet it is being delivered now. Row 15 text and STATUS line 3 both state it is documentation-only and independent, and its sole prerequisite R10c is merged. This does not pull dependent work forward.

9. **External CI references are internally consistent but unverified.** The R10c post-main run id in R15l.md line 8 matches STATUS line 15 and the ROADMAP. I could not confirm those runs or the "four-check-green" state of main without network access.

**Optional polish** (not required for approval):

- `docs/plans/R10c.md:3` still reads "delivery gates pending" although R10c merged as PR 181. R15l.md links to it as the contract, so a reader lands on a stale status line. This predates R15l and is outside its diff.
- The R15 band acceptance paragraph at `docs/ROADMAP.md:802-811` has entries for R15a through R15k but none for R15l. One clause such as "R15l: decision recorded in plan, ROADMAP, PLAN and STATUS" would make the band's acceptance list complete.
- R15l.md item 1 says "finite fan-out". It could note the hard upper bound the runtime enforces at `packages/core/src/turn-strategy.ts:36`, so users know the ceiling is enforced, not advisory.
- R15l.md line 17 asks that this review's findings be preserved. The author should record this review's outcome in the plan before the PR gate.
