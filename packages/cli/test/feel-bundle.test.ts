import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("retains TypeScript exported signatures in an actual split ESM bundle using the CLI build configuration", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["packages/cli/scripts/feel-bundle-check.mjs"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), timeout: 30_000,
  });
  expect(stdout).toContain("PASS: compiled ESM TypeScript repository-map signatures");
}, 35_000);
