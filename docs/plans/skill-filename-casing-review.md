# Independent review — nested skill filename casing

One read-only invocation, frozen `3abfb4e` against `300c5e2`.
Requested maximum24 turns; reported8. Session
`43504569-6e5c-4b33-9a15-b884888610af`; duration73,313ms,
API duration58,919ms; `is_error: false`. No continuation or second review.
Reviewer reports actual70 focused tests and typecheck passing. Hosted platform,
full-suite/Docker and Chromium receipts are separate, not independently reviewed.

## Original result (verbatim)

Review complete. Verdict: **approve**. No defects found in the change under review.

**Commands actually run and results**

| Check | Result |
|---|---|
| `git diff 300c5e2 3abfb4e` | 7 files, +101/-3, one 4-line guard in `packages/cli/src/packages.ts` plus tests and docs |
| `pnpm exec vitest run` on the three named test files | 3 files, 70 tests passed |
| `pnpm typecheck` | all four packages clean |

**What the change does, verified against the loader**

- The new guard at `packages/cli/src/packages.ts:159` matches `skills/<name>/<marker>` case-insensitively and throws unless the captured filename is exactly `SKILL.md`. It runs inside shared `validate`, which is called by both install and inspect. So it covers directory installs, archive installs, and already-installed package loading.
- The core loader at `packages/core/src/tools/skills.ts:129` constructs `SKILL.md` exactly for directory entries, and at line 130 accepts flat files with a case-insensitive `.md` test. The package-side regex at line 170 keeps the same split: flat is case-insensitive, nested is exact. Package validation and loader semantics now agree.
- Trust, path, byte, count, link and integrity controls are untouched. The guard sits before the byte accounting, so refusal happens before any skill parsing or publication.
- The runtime test confirms canonical nested and uppercase flat files load through the real trusted builder into core discovery, and the negative test confirms a refused package never reaches discovery, extension import, or the sandbox sentinel.
- Docs are consistent with the code: six fail-before controls in the tests, and the 70-test count matches the run.

**Informational notes, no action required**

- Packages installed before this change with a noncanonical nested marker will now be refused whole at inspection, not just the one skill. The plan states no migration is claimed, so this is intended, but it is a behavior change on case-insensitive hosts where those packages previously loaded.
- Deeper paths such as `skills/<name>/sub/skill.md` are not touched by the guard. The loader never discovers them either, so they remain ordinary resource files on both sides.

**Omitted or unperformed checks**

- `pnpm build`, the full suite, Docker, Chromium, and hosted gates were not run, per the stated scope.
- This host is WSL2 on a case-sensitive filesystem. The intermediate-rename test's case-insensitive-host branch was not exercised here.
- No agents were spawned, no edits or git mutations were made, and no network, provider, auth, clipboard, or desktop access was used.
