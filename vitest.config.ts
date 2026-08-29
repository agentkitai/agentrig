import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
  resolve: {
    // Tests import workspace packages by name and resolve straight to source,
    // so no build step is needed before `pnpm test`.
    alias: {
      "@harness/core": pkg("core"),
      "@harness/memory": pkg("memory"),
      "@harness/supervisor": pkg("supervisor"),
    },
  },
});
