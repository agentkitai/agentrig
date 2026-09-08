import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import base from "../../../vitest.config.js";
import windows from "../../../vitest.windows.config.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const vitestBin = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));

/**
 * feel #245: the shared `include` is repository-relative, so a workspace-local `vitest run` used to
 * resolve it against `packages/cli` and exit 1 with "No test files found". The root is pinned in the
 * config now, so no caller has to pass `--root ../..`. One small core file, never the whole suite:
 * this test already runs inside vitest.
 */
it("discovers a repository test when vitest runs from the CLI workspace without --root", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    // One file, so one worker: this child runs inside the suite and should not compete with it.
    [vitestBin, "run", "packages/core/test/command-outcome.test.ts", "--reporter=verbose", "--pool=threads", "--maxWorkers=1"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 180_000 });
  const output = stdout + stderr;
  expect(output).not.toContain("No test files found");
  expect(output).toContain("packages/core/test/command-outcome.test.ts");
  expect(output).toMatch(/Test Files\s+1 passed \(1\)/);
}, 200_000);

it("pins the repository root in the shared config and inherits it into the Windows lane", () => {
  expect(base.root).toBe(resolve(repository));
  expect(windows.root).toBe(base.root);
});
