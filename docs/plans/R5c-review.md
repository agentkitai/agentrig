# R5c independent review receipt

One read-only Claude process, session `2a0f745d-4b08-4388-9014-e82bba7f959a`,
244 seconds, exactly 24 reported turns / requested maximum 24. No restart or subagents.
Reviewed head `9bcac82` against integrated main `4d3eb91`. Independent build, typecheck
and full suite passed 2,500 tests plus two skips across 142 files (34 seconds).
No material findings. Original verdict and optional findings follow verbatim; line references
are retained as reported by the reviewer.

## Original review

**Verdict: APPROVE.** No material correctness, security, or portability defects found in the R5c diff against origin/main. Whole-unit rejection, caps, cancellation, and the negative overrides hold as specified.

**Checks actually run** (in this worktree, exit 0):

```
pnpm build && pnpm typecheck && pnpm exec vitest run --maxWorkers=4
Tests  2500 passed | 2 skipped (2502)   Duration 33.90s
```

Also inspected by hand: full `git diff origin/main...HEAD` for source files, `packages/core/src/manifests.ts` (schemas and `resolveManifestNames`), `packages/core/src/extensions.ts:55-115` (candidate dedup, sidecar validation, 32 cap), `packages/core/src/tools/skills.ts:105-150`, `packages/cli/src/config.ts:270-372`, `packages/cli/src/trust.ts:120-160`, and the vendored tar-stream 3.2.1 `extract.js:200-205` plus `headers.js:94-125` to confirm PAX path/size overrides land on the header before your checks read it.

**Boundaries confirmed**

- Trust: `package add` refuses without recorded or explicit trust (`program.ts:469`); discovery only runs with a trusted root (`agent-builder.ts:48`), and `--no-packages`/config `packages: false` flows through `CONFIG_KEYS` since it is a schema key (`config.ts:124,141`).
- Negative overrides: `extensionDiscovery === false` drops package extensions (`agent-builder.ts:54`) and `skillDiscovery === false` drops package skill roots (`agent-builder.ts:65`). Sandbox refusal precedes any import (`agent-builder.ts:56`).
- Precedence: package extensions at 2 sit below explicit 0 and project 1; package skill roots share one precedence value, so cross-package name collisions fail closed via `resolveManifestNames` (`manifests.ts:101`). Packages can never outrank explicit or project roots.
- Archive: traversal, absolute, backslash, colon, control chars, reserved Windows names, case-alias and dir/file collisions all refuse (`packages.ts:191-211`); only `file`/`directory` types pass (`packages.ts:280`); compressed, expanded, per-entry, entry-count and path caps are enforced before or during parse, and the `bounded` transform error propagates through `pipeline` to the async iterator.
- Manifest: strict `PackageManifestV1` refuses any nonempty `scripts`, `dependencies`, `optionalDependencies`, and any `bin` (`manifests.ts:68-72`); validation precedes staging (`packages.ts:372`).
- Publication: private `mkdtemp` staging, cooperative mkdir lock without age stealing, double destination check, single `rename`, cleanup limited to owned staging (`packages.ts:377-393`).
- Integrity: record schema is strict, file list and digest are recomputed from disk and compared, unrecorded entries refuse the package (`packages.ts:410-416`); the aggregate cap discards already-verified packages (`packages.ts:420`).

**Optional polish** (not blocking, no security impact)

- `packages.ts:320` validates skills case-insensitively (`skill.md`, `SKILL.MD`) while core looks up the exact name `SKILL.md` at `skills.ts:127`. A package with `skills/foo/skill.md` installs and is counted, but loads only on case-insensitive filesystems. Dropping the `i` flag for the directory form would make Linux and macOS agree.
- `config.ts:359-361` dedups raw strings while `skills.ts:110` dedups resolved paths. A relative explicit `--skills .agentrig/skills` naming the project directory shifts indices so a later home root can share the package precedence value. The result is a fail-closed collision rather than the documented "home skills follow". Resolving explicit skills against cwd, as `extension` already is at `config.ts:362`, removes the gap.
- `packages.ts:239` refuses any source file with more than one hard link. This rejects pnpm-linked `node_modules` directories as sources. Consistent with the plan, but worth a line in the README.

## Disposition

The root-priority note was elevated to a bounded contract fix, despite its original optional
classification. A real CLI/config/builder control using an explicit alias of the conventional
project root reproduced the missing package winner. Explicit priorities for all resolved roots
now survive loader deduplication; relative and absolute alias controls pass, with project roots
still preferred. No broad review rerun. The other two notes remain roadmap-END polish.
