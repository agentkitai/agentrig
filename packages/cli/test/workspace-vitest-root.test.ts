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
it.each(["0", "1"])("discovers a repository test when vitest runs from the CLI workspace without --root (color=%s)", async color => {
  const env = { ...process.env, TERM: "xterm", FORCE_COLOR: color };
  delete env.NO_COLOR; delete env.NODE_DISABLE_COLORS;
  if (color === "0") env.NO_COLOR = "1";
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    // One file, so one worker: this child runs inside the suite and should not compete with it.
    [vitestBin, "run", "packages/core/test/command-outcome.test.ts", "--reporter=json", "--pool=threads", "--maxWorkers=1", color === "1" ? "--color" : "--no-color"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), env, timeout: 180_000 });
  expect(stdout + stderr).not.toContain("No test files found");
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ success: true, numPassedTests: 2, numFailedTests: 0 });
  expect(report.testResults).toHaveLength(1);
  expect(report.testResults[0].name.replaceAll("\\", "/")).toContain("packages/core/test/command-outcome.test.ts");
}, 200_000);

it("pins the repository root in the shared config and inherits it into the Windows lane", () => {
  expect(base.root).toBe(resolve(repository));
  expect(windows.root).toBe(base.root);
});
