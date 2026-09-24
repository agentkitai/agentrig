import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import migration from "../test-migration.json";
import product from "../../../vitest.config.js";
import pack from "../vitest.config.js";
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
it("M-lane-leak: migrated files exist only in the explicitly separate pack lane", () => {
  expect(product.test?.include).toEqual(["packages/*/test/**/*.test.ts"]);
  expect(pack.test?.include).toEqual(["packs/ship/test/**/*.test.ts"]);
  for (const path of migration.moved) {
    expect(existsSync(new URL(`../../../${path}`, import.meta.url))).toBe(false);
    expect(existsSync(new URL(`./${path.split('/').at(-1)}`, import.meta.url))).toBe(true);
  }
});
it("M-ci-lane-removed: every PR runs pack checks and CRLF checks without a path filter", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain("pull_request:");
  expect(ci).not.toMatch(/paths(?:-ignore)?:/);
  const job = ci.split("  ship-pack:\n")[1]?.split("\n  windows-sandbox-none:")[0];
  expect(job).toContain("run: pnpm test:ship\n");
  expect(job).toContain("run: pnpm test:ship:crlf\n");
});
