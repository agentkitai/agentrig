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

Remaining R19c slices: installed packaging/host wiring as needed, skills and roles,
SHIPPING-WORKFLOW and shared includes, instruction/script-test ownership and the
required pack CI lane. Existing tests remain where they are, and no gate grows here.
R19d–f train extraction, bolt-on retirement and hook gate migration remain deferred.
