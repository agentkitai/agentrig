# Ship source pack

`pack.json` inventories this source skeleton. Trusted hosts can register `shipPack`
from `index.mjs` with the public `buildProgram({ packs: [shipPack] })` API; `ship info`
is informational only. No filesystem pack auto-loader or published npm package is implied; explicit
foreign-project source-install activation is documented below.
The reserved `packs.ship` namespace is registered/validated by the R19b compatibility
bridge, not a second schema. Repository config keeps identical top-level checks and
reviewers for old raw readers while recording their namespaced equivalents.

Scripts live in `scripts/`; all repository `scripts/*.mjs` paths remain executable
and importable compatibility shims. The dispatch extension lives in `extensions/`;
the repository discovery entry and adjacent manifest stay in `.agentrig/extensions`.
Do not register both extension paths: they represent the same extension, not two hooks.

`public-api.mjs` resolves only the CLI package-root export via the source workspace's
package manifest. Run `pnpm install --frozen-lockfile && pnpm build` first, as before.
The command bootstrap remains source-based. R19d first slice adds a private workspace
package for the typed train stages; it does not introduce automatic pack activation.
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
activation is needed. Published npm packaging remains outside this source-install slice.

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

## Train stages (R19d first slice)

`@agentkitai/agentrig-ship/train` supplies `shipTrainStages`: existing pre-checks,
ship prompt, strict `{pr}` receipt and merged-PR/post-merge-CI verification.
`@agentkitai/agentrig-ship/train-github` owns the bounded #538 GitHub rate-limit
transport retry; decorating the same wrapper twice does not multiply retry budgets.
The CLI helper is a compatibility wrapper. `test/train-github.test.ts` covers both
the old core/CLI path and public train+ship composition in this lane.

The generic engine is `@agentkitai/agentrig-train`. The CLI composes the train engine with these defaults; the former core facade
and core exports were removed by the final R19d slice. No topic/session changes,
bolt-on retirement or hook-gate migration are included; no gate grows here.

## Lander role installation

For this repository, `ship:sync` maintains `.agentrig/agents/lander.md` from
`agents/lander.md`. For a foreign trusted project, use the explicit source-install
activation described below; it supplies the role without copying into the target.
Registering `shipPack` alone remains informational and does not activate roles.

Ship/topic landing dispatch uses `subagent({ agent: "lander", task: "..." })`.
The manifest retains the host role's explicit tool allowlist (including overflow
recovery), `model-role: subagents`, and `delegable: false`. It neither selects a
provider nor grants permissions or merge consent. The activated dispatch/merge
hooks must still bind the child and PR; missing roles halt rather than falling
back to an unnamed child. `pnpm test:ship` checks the tracked role in a fresh
checkout and exercises a grant using its production-discovered snapshot.

## Foreign repositories: explicit source-install activation

This portability slice supports an **external, built, user-owned AgentRig source
installation**. It does not publish an npm pack, execute install hooks, or copy
files into the foreign repository. Keep that installation at a stable absolute
path, run its `pnpm install --frozen-lockfile && pnpm build`, and invoke:

```sh
node /absolute/agentrig/packs/ship/activate.mjs /absolute/foreign /absolute/declaration.json
```

The declaration is ordinary strict AgentRig config, for example:

```json
{
  "packs": {
    "ship": {
      "checks": {
        "bootstrap": "python -m pip install -e .",
        "steps": [{ "name": "unit", "command": "python -m pytest" }]
      },
      "reviewers": {},
      "ciWorkflows": ["Foreign CI"]
    }
  }
}
```

Use real reviewer slots/pins where required; `{}` means explicitly zero slots,
not an exemption from CI or authorization. API slots still require matching
provider entries. Workflow names are exact hosted names, not success assertions.
Activation prints their value for the operator's train row
`environment.ciWorkflows`; it does not invent a workflow or alter queued rows.
The row's checkout/repository/base branch still select the foreign clone and its
GitHub origin is verified exactly. Use the existing train command from the
external installation, not a target-repository pnpm script.

Activation writes one operator-owned declaration under
`~/.agentrig/projects/<sha256-repository-identity>/config.json`, plus resolved skill
snapshots beside it. Git repositories are keyed by their canonical common Git directory (other
directories by canonical root). Linked Git worktrees resolve that same declaration through
Git's common directory. A committed `.agentrig/config.json` takes precedence as a
whole; there is no field merge with the fallback. Activation refuses existing
project config or an existing activation rather than overwrite either. Inspect
and edit the operator declaration explicitly to change checks or slots; keep
snapshot/source paths stable. To refresh the generated skill snapshot, remove
only that owned activation directory after all its sessions stop, then activate
again. Never delete project state or durable review evidence.

Activation does **not** grant trust. Trust the foreign project through the normal
CLI trust flow (and use the normal trust mechanism for owned worktrees). Unsafe
home-within-project state remains ignored. The configured extension still executes
ambient host code; enforcing sandboxes still refuse it. Role limits, permissions,
provider selection, dispatch provenance, the merge/ledger guards, reviewer pins,
human authorization and exact-head/post-merge CI all remain unchanged.

The six resolved skills retain their complete policy text and append explicit
absolute addresses for pack scripts, policy, merge-guard docs, checks API and the
per-repository declaration. Both `scripts/<helper>.mjs` and the canonical
`packs/ship/scripts/<helper>.mjs` spellings resolve to that installation, including
the mandatory child-result `schema` and `assess` commands. The foreign fixture
audits pack-owned script/doc references in every composed skill and executes
child-result assessment without copying resources into the foreign checkout.
Scripts retain source-install public-API wiring; no
private CLI import is added. The canonical lander manifest now lives in
`packs/ship/agents/lander.md`; `ship:sync` maintains the repository compatibility
copy. `agentRoleRoots` supplies explicit absolute trusted-host role directories;
invalid or duplicate roles refuse rather than shadow project roles. It grants no
new tools or merge consent. This replaces the old copy-into-project installation
recipe below/above; no target `.agentrig` directory is needed for activation.

Read-only integrations use public `readProjectConfig(root, { home? })` to obtain
both parsed config and its source path, and `resolveProjectChecks` for effective
profile checks. Record the selected source, profile and declaration contents with
same-head check receipts; local declarations are operator state, not claimed to
be committed at the PR head. Global home checks/reviewer preferences never supply
project commands or slots. Train now executes these declared commands in order,
stopping on nonzero; missing declarations refuse, and empty steps execute nothing
(including bootstrap/preflight). Existing injected SDK callers without the new
host callback retain their legacy fixed precheck path; CLI supplies the callback.

Next slice: adopt an existing PR with explicit provenance/review/head binding.
No adopt-existing-PR automation, npm publishing, or automatic activation is
claimed here. LOW wording/polish observations remain R19 advisories.
