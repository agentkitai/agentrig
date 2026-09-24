# Ship source pack

`pack.json` inventories this source skeleton. Trusted hosts can register `shipPack`
from `index.mjs` with the public `buildProgram({ packs: [shipPack] })` API; `ship info`
is informational only. No filesystem pack auto-loader or installed package is implied.
The reserved `packs.ship` namespace is registered/validated by the R19b compatibility
bridge, not a second schema. Repository config keeps identical top-level checks and
reviewers for old raw readers while recording their namespaced equivalents.

Scripts live in `scripts/`; all repository `scripts/*.mjs` paths remain executable
and importable compatibility shims. The dispatch extension lives in `extensions/`;
the repository discovery entry and adjacent manifest stay in `.agentrig/extensions`.
Do not register both extension paths: they represent the same extension, not two hooks.

`public-api.mjs` resolves only the CLI package-root export via the source workspace's
package manifest. Run `pnpm install --frozen-lockfile && pnpm build` first, as before.
This source bootstrap deliberately does not add a workspace package or lockfile change.
Reviewer-home validation is exported additively through the public CLI API; its
existing train/doctor callers remain intact. No provider credentials or reviewer homes are embedded here.

## Workflow skills and policy

`skills/{arbiter,dogfood,land,review,ship,topic}.md` are the pack's six workflow
entries. Their names, descriptions and resolved bodies are unchanged. Discover
`packs/ship/skills` with the existing core skill discovery API; this source pack
still does not opt the repository into pack activation or install discovery roots.
The inventory in `pack.json` is descriptive, not a new runtime manifest contract.

The flat entries intentionally share one bundle root: R19a resolves every include
relative to the entry's directory and rejects upward traversal. `shared/` holds
25 reused fragments from the initial-review heading contract, declared-checks
policy, trusted model provenance, and review scratch cleanup. `parts/` retains
role-specific text and whitespace. Fragment files have no skill frontmatter and
are not discovered as skills. Includes preserve authored ordering; no flags or
assets are added, since either could alter existing behavior or resolved text.
Do not reflow fragments or normalize internal blank lines as incidental cleanup.

`docs/SHIPPING-WORKFLOW.md` is the canonical policy. The pack is the single source
of truth: edit that file and `skills/` here, then run `pnpm ship:sync` after
`pnpm build`. This regenerates the checked-in `.agentrig/skills/*/SKILL.md` and
repository `docs/SHIPPING-WORKFLOW.md` compatibility outputs. `pnpm ship:check`
fails on missing or changed outputs without writing them; CRLF checkout conversion
is tolerated, not semantic drift. Core's public discovery API resolves the bundles;
there is no second include parser. Existing host discovery continues loading the
flat compatibility outputs, so no simultaneous double-registration or new host
activation is needed. Installed packaging remains outside this source-pack slice.

## Owned tests and CI

`test/` owns the workflow instruction contracts, script regressions, compatibility
and ownership checks. `test-migration.json` records moved files and the three mixed
files whose runtime/config cases stay in product. The preserved review fixture
moves with its consumers. `pnpm test:ship` runs preflight, drift verification, and
this explicit Vitest lane; `pnpm test` remains product-only. The `ship-pack` CI job
runs on every PR, without path filters. `pnpm test:ship:crlf` runs the complete lane
with an entire-tree CRLF compatibility fixture through the shared loader override.
The Windows job retains its original moved workflow checks in their new pack home;
its product inventory filters out moved files through `test/vitest.windows.config.ts`.

No R19d topic/session/train move, fresh-session flag migration, bolt-on retirement,
or hook-gate migration is included. No gate grows here.
