/**
 * Ink checks `is-in-ci` BEFORE it checks whether the frame is too tall (`ink/build/ink.js`,
 * `onRender`) and returns having written only the `<Static>` output. GitHub Actions sets `CI=true`
 * on every step, so under CI — the only place these tests run automatically — the frame-height
 * guards in `packages/cli/test/tui-frame.test.ts` could not fail. Reverting the fix they guard
 * left all four of them green.
 *
 * `is-in-ci` computes its value at module load, so this has to happen before any test file imports
 * Ink: a setup file does, `vi.stubEnv` inside a test does not.
 */
for (const key of Object.keys(process.env)) {
  if (key === "CI" || key === "CONTINUOUS_INTEGRATION" || key.startsWith("CI_")) {
    delete process.env[key];
  }
}

// Every test file gets a read-only before/after guard. Anchor to this checkout,
// not process.cwd(): tests may chdir, and Vitest runs files in parallel workers.
// Never delete leaks here; a failure must preserve evidence (and genuine sessions).
import { afterAll, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { snapshotStore } from "./project-store.js";

const projectStores = ["", "packages/cli/", "packages/core/", "packages/memory/", "packages/supervisor/"]
  .flatMap((base) => ["raw/sessions", "wiki"].map((store) =>
    fileURLToPath(new URL(`../${base}.agentrig/${store}`, import.meta.url))));
const inventory = () => Object.fromEntries(projectStores.map(path => [path, snapshotStore(path)]));
const before = inventory();
afterAll(() => {
  const after = inventory();
  expect(after, "test suite must leave project session stores and wiki untouched").toEqual(before);
  for (const snapshot of [before, after]) {
    for (const [root, entries] of Object.entries(snapshot)) {
      for (const [path, state] of Object.entries(entries)) {
        expect(state, `${root}/${path}: removed-during-inventory`).not.toBe("removed-during-inventory");
      }
    }
  }
});
