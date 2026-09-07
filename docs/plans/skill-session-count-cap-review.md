# Generated-skill session count — independent review

One substantive Claude review of frozen c012ebfd77f939c5456f0b0b58f2ac9d79c04968
against ebfd10f8dac970a6560e451c7ebe42d9878cacdf. Requested 24 / reported 23 turns;
169,139 ms; session 50db3c06-bae5-4802-9703-9d9b51003b3f. APPROVE, no material findings.
No continuation or second review. One ad-hoc node parser command was denied;
76 focused tests, build and typecheck were independently executed successfully.

Author response: corrected the roadmap wording to identify the core skill parser's
metadata cap rather than the evidence loader's default. No production or test edits
after review. The pure serializer returns text, never writes it; the review's old-code
“would have written” wording refers to a hypothetical downstream use, not a reproduced
publication bypass. The normal evidence bound and all publication gates remain unchanged.
The original trial used malformed synthetic bare IDs; correcting them to session-prefixed
IDs then produced the intended single 129-count failure (22 other tests passed).
After the guard, 76 focused tests, build/typecheck, required pinned real-Docker full
3,318 passed plus two existing skips / 209 files (88.18s), and Chromium 1 (2.57s) pass.
These author results are separate from the review. Exact-head and post-main CI follow.

## Original result (verbatim)

## APPROVE

Scope reviewed: `packages/memory/src/dream/skills.ts`, `packages/memory/test/skill-emission.test.ts`, `docs/plans/skill-session-count-cap.md`, ROADMAP/STATUS, diffed against `ebfd10f`.

### Verification

**128-distinct cap after deduplication** — `skills.ts:33-34` dedupes and sorts first, then refuses `> 128`, so the bound is on distinct references, not raw input length. This is exactly the invariant the core parser enforces independently (`packages/core/src/manifests.ts:203`: `z.array(...).min(2).max(128)`), so the serializer can no longer emit a file its own parser would reject. The lower bound (`min(2)`) needs no mirror: `promote.ts:134` floors `minSessions` at 2 via `Math.max(2, …)`, so `publicationSources` is structurally ≥2.

**Byte bounds and emission gates unchanged** — the 8192-char `agentrig-sessions` check, 1024 `from`, 128 `dream`, 1024 description, 64 KiB `MAX_FILE` and 16000-byte head checks are byte-identical (`skills.ts:43,46,51`). The metadata value is the same `JSON.stringify` of the same deduped/sorted array as before, only hoisted into a local, so digests and existing fixtures are unaffected (confirmed by the unchanged first test asserting a stable `preview.skillEmission.digest` across regeneration). `prepareProcedureSkills` is unchanged apart from the rename at line 155; digest match, `refinementError`, guardrail receipts, `writeProposals` ownership/symlink/lock logic all untouched.

**Internal-only helper, no new authority** — `dream/index.ts` exports only `type { SkillEmissionOptions, SkillEmissionReport, SkillProposal }` from `skills.js` (no `export *`), and `packages/memory/package.json:9` maps only `"."`, so there is no deep-import subpath. The function value is not reachable as package API; the only importer in the tree is the test (`../src/dream/skills.js`). It performs no evidence validation, no writes, no publication — the throw is its entire added behavior.

**Test honesty** — the candidate comes from a real structural dream (`preview.report.procedures.candidates[0]`); only `artifact.publicationSources` is replaced, and the comment at line 58 says so. The 128 case feeds duplicated input (256 entries) and asserts the *actual* core parser accepts the output twice over (`parseSkillFrontmatter` round-trip equals the sorted set, `parseSkill` accepts name/path). Line 63 asserts the 129-entry JSON is under the 8192-char cap, which is what makes the refusal attributable to the new count guard rather than the byte cap. Line 65 confirms no file was produced. Nothing in the test claims to bypass the already-bounded evidence loader, and `evidence.ts:77` (`maxSessions ?? 128`) plus `promote.ts:164` (`witnesses.slice(0, minSessions)`) support the plan's "defensive, not a demonstrated bypass" framing — >128 sources requires a caller to raise both `minSessionsToPromote` and `maxSessions` well past their defaults.

**Pre-guard 129 failure**: verified statically, not re-executed. 129 short refs serialize to ~1.8 KB, far under 8192, so the old code would have written a file that `manifests.ts:203`'s `.max(128)` rejects. I attempted an ad-hoc `node -e` parser probe to demonstrate the 128/129 boundary directly against built `dist`; the Bash call was denied by permission mode, so that half rests on code reading rather than execution.

### Findings

- **Nit (docs, `docs/ROADMAP.md:1243`)**: "matching the loader format" — the guard matches the *core skill parser's* metadata array cap, which merely coincides with the loader's default of 128. `docs/plans/skill-session-count-cap.md:10-11` states both correctly; the ROADMAP line is the loose one. The ragged wrap at lines 1244-1245 is cosmetic. The run-together numerals ("more than128", "the8192-character") match existing house text in STATUS (e.g. the pre-existing "as main8f741a80…"), so I read them as style, not new typos.
- **Informational**: a >128 candidate throws out of `prepareProcedureSkills` and rejects the whole dream rather than dropping that one candidate. That is the file's existing convention (the 8192/description caps behave identically), so it is not a regression — just noting the failure mode is fatal-per-run, not per-proposal.
- Hosted claims in STATUS (post-merge CI IDs 34109938845 / 34109938825, PR #217/#218 receipt links) were not verified; fetching is out of scope for this review.

### Tests actually executed

- `pnpm exec vitest run packages/memory/test/skill-emission.test.ts packages/memory/test/procedures.test.ts packages/cli/test/skill-emission.test.ts packages/core/test/manifests.test.ts packages/core/test/generated-skills.test.ts` — **5 files, 76 tests passed** (3.83s).
- `pnpm typecheck` — clean across core/memory/supervisor/cli.
- `pnpm build` — clean, all four packages.

Static only: full suite, Chromium, hosted CI, and the pre-guard 129 behavior.

