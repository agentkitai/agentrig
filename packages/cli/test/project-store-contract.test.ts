import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import windows, { windowsCoverage } from "../../../vitest.windows.config.js";
import base from "../../../vitest.config.js";

it("runs the inventory and wiring regressions with the inherited guard in the Windows lane", () => {
  expect(windows.test!.setupFiles).toEqual(base.test!.setupFiles);
  expect(windowsCoverage).toEqual(expect.arrayContaining([
    "packages/cli/test/project-store.test.ts",
    "packages/cli/test/project-store-races.test.ts",
    "packages/cli/test/project-store-wiring.test.ts",
    "packages/cli/test/project-store-contract.test.ts",
  ]));
});

it("documents guard coverage, quiescence and a safe remedy rather than an opt-out", () => {
  const doc = readFileSync(new URL("../../../docs/TESTING.md", import.meta.url), "utf8")
    .split("## Project-store suite guard\n")[1]?.split("\n## ")[0];
  expect(doc).toBeDefined();
  for (const text of ["raw/sessions", "wiki", "snapshots", "SHA-256", "symlinks", "quiescent",
    "concurrent legitimate AgentRig session", "separate checkout", "no opt-out", "removed-during-inventory"]) {
    expect(doc).toContain(text);
  }
});

it("keeps the historical #313 record aligned with both moved-main routes", () => {
  const status = readFileSync(new URL("../../../docs/STATUS.md", import.meta.url), "utf8")
    .split("## Historical MAIN in rerun matching")[1]!.split("\n## ")[0]!;
  expect(status).toContain("§1 CI-staleness");
  expect(status).toContain("§3 conflict/material-delta");
  expect(status).toContain("rather than causing a redundant initial pair");
});
