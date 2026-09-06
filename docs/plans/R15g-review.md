# R15g independent review — verbatim final summary

Frozen snapshot: `2a82c39`, base `887fef8`. Session
`72d41141-cc7d-435e-beb9-a1f05558f142`.
One substantive read-only review: requested 24 turns; CLI reported 25 and
`error_max_turns`, 367.641 seconds, without a final verdict. Coordinator then
authorized exactly one tools-disabled final-summary turn in the same session,
existing evidence only: one reported turn, 23.754 seconds. No second investigation
or review. Source remained frozen through both. The summary below is preserved
verbatim; subsequent author fixes are recorded separately in R15g.md.

**Verdict: REQUEST_CHANGES.** One material defect confirmed by an independent probe; everything else I checked held.

**Independently run checks**

| Check | Result |
|---|---|
| `pnpm build` | passed |
| `pnpm typecheck` | passed |
| Focused: core and cli `output-schema.test.ts`, `tool-emit-allowlist.test.ts` | 30 passed, 3 files |
| Full `vitest run --maxWorkers=4` with the required worker/checker Docker images and `AGENTRIG_EVAL_REQUIRE_DOCKER=1` | 178 files, 2888 passed, 2 skipped, 57.8 s |
| Probe script against built `dist` (schema-instruction accumulation, AJV strictness, parser edges) | ran; observations below |

**Material finding**

- **Prompted schema instruction accumulates in the persistent system prompt** at `packages/core/src/agent.ts:654`. When the repository map content is empty (`repoMap: false`, `--no-repo-map`, or an empty map), `requestSystemBlocks` still aliases `systemBlocks` from line 639, and the new `push` mutates the session-wide array every turn. Probe with a 3-tool-turn then final-answer session: the model request contained 1, 2, 3, then 4 copies of the "Return your final answer" block, and the context manifest recorded 4, 7, 10, 13 system blocks. With a 32 KiB schema and the CI ceiling of 20 turns this adds up to roughly 640 KiB of duplicated system text, breaks the cache-prefix hint, and skews the pre_model patch comparison. The shipped tests miss it because the CLI test's schema is tiny and the core fixture never checks request system text across tool turns. Fix is to copy before pushing, for example `requestSystemBlocks = [...requestSystemBlocks, block]`, plus a test asserting one copy on turn N.

**Verified as correct**

- Strict schema bounds: duplicate keys including `\u0061` escapes refuse; `__proto__` property, tuple `items`, empty `enum`, `required` naming an undeclared property, `properties` without `type`, union `["string","number"]`, `pattern`, `$ref`, oversized enum all refused. Nullable pairs with object properties compile. Parser yields null-prototype objects; trailing data, BOM, and duplicate keys throw. Final text over 16,384 nodes returns `bound`.
- Native mode: capability is set only by trusted CLI code on the actual `OpenAICompatibleProvider` instance, `createAgent` refuses native without it, the ChatGPT backend is a separate class and cannot receive the field, and the wire body is exactly `response_format.json_schema{name,strict:true,schema}`. Empty tool lists omit `tools` from the OpenAI body, so the repair request is wire-valid.
- Refusal handling: the refusal stop breaks before the repair guard, so a refusal is never a repair candidate and the finally block converts the session to `error`. Native streaming refusal test exits 1 with text retained in the log.
- One repair: guard at `agent.ts:907` precedes the max_tokens continuation block and the strategy dispatch at line 963, so repair tool calls and truncation get paired non-execution results and an error with no H7a continuation. Budget, pre_model veto, and abort before the repair emit no repair event.
- Existing behavior: with no contract the only changed expression is `tools: outputRepair ? [] : toolSpecs` with `outputRepair` always false. Child agents get an explicitly constructed config without the contract. Exit status maps any non-`done` reason to 1; CI report includes validation status and refuses comments on error.

**Optional polish, non-blocking**

- The OpenAI SSE refusal change at `providers/openai.ts:137` and `220` alters unconstrained runs: refusal text now streams as assistant text and ends with reason `refusal` instead of `end_turn`. Worth a one-line note in the PR since it is outside the flag.
- A resumed session resets the repair allowance, so a session that already consumed its repair can repair once more after resume. Consistent with the contract's "new explicit attempt" wording, but worth stating in `docs/STRUCTURED-OUTPUT.md`.
- Schema depth check is off by one relative to the documented limit: depth 12 permits 13 nesting levels.
