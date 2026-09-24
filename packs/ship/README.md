# Ship source pack — R19c first slice

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

## Workflow skills and policy (R19c second slice)

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

`docs/SHIPPING-WORKFLOW.md` is the pack's byte-identical policy copy. During the
train, `.agentrig/skills/*/SKILL.md` and repository `docs/SHIPPING-WORKFLOW.md`
remain compatibility copies, not wrappers or broken links. Their current paths
and all paths mentioned inside the instructions continue to work in this repo.
Keep compatibility copies synchronized with any intentional pack instruction
edit until the activation slice prescribes replacement wiring. The ordinary
core test lane checks all six resolved bodies (including model-tool output)
against those copies using LF and CRLF trees, and checks policy-copy equality.
Existing instruction-contract tests remain unchanged at compatibility paths.

R19c remains incomplete: later slices handle installed packaging/host activation
and roles as needed, instruction/script-test ownership and the separate pack CI
lane. No pack test lane, CI job, fresh-session flag migration, or R19d topic
session-end policy is introduced by this slice. R19d–f train extraction, bolt-on
retirement and hook gate migration remain deferred. No gate grows here.
