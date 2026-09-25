import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Execute the real setup in a disposable checkout, never deliberately leak into this checkout.
// Separate child runs prevent one store's leak from masking a missing path in the guard.
it.each(["raw/sessions", "wiki"].flatMap(kind =>
  [null, "", "packages/cli/", "packages/core/", "packages/memory/", "packages/supervisor/"].map(base => ({ kind, base })),
))(
  "setup teardown detects only changed stores ($kind at $base)",
  ({ kind, base }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentrig-store-wiring-")));
    try {
      mkdirSync(join(root, "test"));
      for (const name of ["setup-no-ci.ts", "project-store.ts"]) {
        copyFileSync(new URL(`../../../test/${name}`, import.meta.url), join(root, "test", name));
      }
      symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)),
        join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(root, "vitest.config.mjs"), `export default { test: {
        include: ['probe.test.js'], setupFiles: ['./test/setup-no-ci.ts'],
      } };`);
      const store = base === null ? null : join(root, base, ".agentrig", kind);
      writeFileSync(join(root, "probe.test.js"), `
        import { it, expect } from 'vitest';
        import { mkdirSync } from 'node:fs';
        it('fixture body passes', () => {
          ${store === null ? "" : `mkdirSync(${JSON.stringify(store)}, { recursive: true });`}
          expect(true).toBe(true);
        });
      `);
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)),
        "run", "--config", join(root, "vitest.config.mjs"),
      ], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } });
      const output = result.stdout + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(result.signal, output).toBeNull();
      expect(result.status, output).toBe(store === null ? 0 : 1);
      // The fixture itself passes: the failure must come from the registered teardown guard.
      expect(output).toMatch(/Tests\s+1 passed/);
      const diagnostic = kind === "wiki" ? "test suite must leave project wikis untouched" : "test suite must leave project session stores untouched";
      if (store !== null) expect(output).toContain(diagnostic);
      else expect(output).not.toContain(diagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000,
);


it("Windows includes the inventory and setup-wiring regressions and inherits the guard", async () => {
  const { windowsCoverage, default: windows } = await import("../../../vitest.windows.config.js");
  const { default: base } = await import("../../../vitest.config.js");
  expect(windowsCoverage).toEqual(expect.arrayContaining([
    "packages/cli/test/project-store.test.ts", "packages/cli/test/project-store-wiring.test.ts",
  ]));
  expect(windows.test?.setupFiles).toEqual(base.test?.setupFiles);
  expect(windows.test?.setupFiles).toContain("./test/setup-no-ci.ts");
});
