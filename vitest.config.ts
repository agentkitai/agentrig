import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // `include` below is repository-relative, so the root has to be this file's directory rather than
  // the caller's cwd: a `vitest run` from `packages/cli` otherwise resolved the glob under that
  // package and exited "No test files found" (feel #245). Derived from `import.meta.url`, so the
  // configs that spread this one — Windows and web — inherit the same root.
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Ink disables the render path the TUI frame tests assert on whenever `CI` is set, which is
    // every GitHub Actions step. See the setup file for what that hid.
    setupFiles: ["./test/setup-no-ci.ts"],
  },
  resolve: {
    // Tests import workspace packages by name and resolve straight to source,
    // so no build step is needed before `pnpm test`.
    alias: {
      "@agentkitai/agentrig-core": pkg("core"),
      "@agentkitai/agentrig-memory": pkg("memory"),
      "@agentkitai/agentrig-supervisor": pkg("supervisor"),
    },
  },
});
