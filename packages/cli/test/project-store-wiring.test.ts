import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Execute the real setup in a disposable checkout, never deliberately leak into this checkout.
// Separate child runs prevent one store's leak from masking a missing path in the guard.
it.each([null, ...["", "packages/cli/", "packages/core/", "packages/memory/", "packages/supervisor/"]
  .flatMap(base => ["raw/sessions", "wiki"].map(store => `${base}.agentrig/${store}`))])(
  "setup teardown detects only changed stores (store=%s)",
  (base) => {
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
      const store = base === null ? null : join(root, base);
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
      if (store !== null) expect(output).toContain("test suite must leave project session stores untouched");
      else expect(output).not.toContain("test suite must leave project session stores untouched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000,
);
