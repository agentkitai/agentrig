# R5c — local, create-only package bundles

This supersedes the retained R5 draft's package section. R5e's actual strict manifest is
mandatory; all nonempty scripts, runtime/optional dependencies and bin entries refuse.
R5b PR #167/main `fef3f46` passed exact post-merge CI 34031416228 on all three platforms.

`agentrig package add <directory|local.tgz|local.tar.gz>` requires the existing project trust
boundary and copies under canonical `.agentrig/packages/`. Installation never executes code,
imports extensions, installs dependencies or invokes lifecycle scripts. No URLs, registry,
git fetch, replacement or uninstall. An occupied destination refuses and remains intact.
An opaque, portable directory key derives from the package name; its manifest retains identity.

The maintained parser is [tar-stream 3.2.1](https://github.com/mafintosh/tar-stream/tree/v3.2.1),
published 2026-08-25 according to npm metadata checked 2026-09-06. Its upstream
[API](https://github.com/mafintosh/tar-stream#extracting) and
[security advisories](https://github.com/mafintosh/tar-stream/security/advisories) were inspected.
This is a dependency choice, not an absence-of-vulnerabilities claim. Its logical USTAR/PAX/GNU
entries are checked after parser overrides; no custom tar-header parser is introduced.
Compressed input is capped at 20 MiB before decompression; all expanded bytes, including
metadata, are capped at 100 MiB before reaching the parser. At most 2,000 logical entries and
4 KiB paths are accepted. Only regular files/directories, with portable non-colliding final
paths beneath `package/`, are accepted. Traversal, absolute paths, links and device entries refuse.

Only package.json, extensions/, skills/, prompts/ and README/LICENSE files are copied.
Unknown top-level content is listed as ignored. Package and loadable skill/extension manifests
validate as a whole before publication; no extension import is used for validation. Prompt files
are copied/listed inertly: there is no prompt-pack consumer and installation injects no text.

Owned private staging plus a cooperative install lock and final directory rename publish one
complete create-only unit. Cancellation/refusal removes only this operation's staging. Locks
are not stolen by age. Human/external races and crashes are not a filesystem transaction;
stop installers before manually recovering a stale named lock or owned staging directory.
Existing installed/user files are not removed or overwritten.

A versioned file-list/content digest detects subsequent changes before automatic discovery.
It is not authenticity, approval or attestation: repository authors can change data and record.
Untrusted projects never auto-load packages; ordinary trust, extension pre-import warnings and
non-none sandbox refusal still apply. `--no-packages` / config false disables discovery.
Explicit and trusted project roots precede packages; home skills follow. Equal-level package
surface collisions fail closed, and skill/extension negative overrides keep their meanings.
Doctor reports integrity without importing package code. No user/model text grants authority.

Actual CLI, loader, doctor, npm pack --ignore-scripts, malformed archive, script sentinel,
tamper, duplicate, trust/override, cancellation/cap and preservation tests precede delivery.
Full checks, restored named mutants, exactly one bounded independent review, updated-main PR
all-platform CI and root-controlled merge/post-merge CI remain required. No live evaluation spend.

## Implementation checks

Integrated main `4d3eb91`, preserving R11b web_fetch reservation and R14c's evidence-only CLI
path. Own build/typecheck/full suite passed 2,500 tests plus two skips across 142 files
(four workers, 37 seconds). Twenty-six focused package cases include real npm pack output,
CLI trust/doctor/import sentinel, archive metadata expansion caps, staging cancellation and
aggregate discovery exhaustion (no previously verified partial catalogue escapes).

Named negative mutations were detected and restored: removing archive type refusal failed
all five link/device cases; bypassing installed-record comparison loaded the edited skill and
failed the preservation/integrity test; stripping scripts before manifest validation incorrectly
published the booby-trapped unit and failed the script refusal test. No mutations remain.

The single independent [review](R5c-review.md) approved and independently passed build,
typecheck and all 2,500 tests plus two skips (34 seconds, 24/max24 turns, 244 seconds).
Its optional root-alias note was treated as material to our precedence contract: an actual
CLI/config/builder alias fixture first failed because package/home became equal priority.
The builder now maps all resolved roots explicitly before deduplication; relative/absolute
alias controls pass and project definitions still win. No second broad review was run.
Nested skill filename casing and more prominent hardlink-source guidance remain optional END
follow-ups; source hardlinks are deliberately refused, including pnpm-linked files.

Final updated-main build/typecheck/full suite after the alias fix passes 2,502 tests plus two
skips across 142 files (four workers, 34 seconds); all 28 focused package cases are included.
Exact-head all-platform PR CI remains a delivery gate, followed by root merge and main CI.

First PR head `29dcabf` CI 34033531560 failed one new macOS doctor fixture assertion (not
a timeout): the fixture manually wrote trust for a noncanonical temporary path, while project
trust uses its canonical path (`/var` aliases `/private/var` on macOS). The fixture now resolves
its temporary root before constructing the persisted trust record, matching existing trust
fixtures; production trust checks and the assertion remain intact. No blind CI rerun and no
new broad review. The assertion now prints the actual doctor report on failure.

The same old head's Windows job also failed only that doctor assertion; the other 27 package
cases passed, including real npm pack (11 seconds). A filesystem-alias regression now proves
locally that noncanonical persisted keys are ignored and canonical keys expose the verified
package without importing code. Canonicalization is the diagnosis for the CI failures; the
Windows-specific cause remains an inference until updated CI confirms it. No timeout changes
or skipped assertions. Main `3d45d9f` (R10d PR #171) is integrated before the next head, retaining
explicit provider probing and the ordinary offline doctor path.

Combined final build/typecheck, 91 package/doctor/provider focused cases and the full suite
pass after integration: 2,520 tests plus two skips across 144 files (four workers, 34 seconds).
This includes 29 package controls, without replacing either platform's failing doctor assertion.

Head `5c105f5` then passed all three CI platforms in 34034014045: Linux/macOS attempt one;
Windows passed the single authorized diagnostic attempt two after an unchanged X1 five-second
fixture timeout. Its 29 package controls, including canonical trust, passed. The timeout and
local isolated 1.20-second pass are preserved in PR receipts; timing variance was not proven.

The preceding main gate required separate child-grant readiness repair PR #173. Integrated
main `063cac6` retains its shared readiness helper/tests and Windows test group, plus R10d's
provider-probe path. Combined build/typecheck, 93 focused package/doctor/provider/readiness
cases and full 2,526 tests plus two skips across 145 files pass (four workers, 37 seconds).
No new broad review or package production edits. Fresh exact-head CI and repaired-main
post-merge CI remain required; PR #171/#173 are not claimed done before that gate is green.
