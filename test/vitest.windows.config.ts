import { defineConfig } from "vitest/config";
import windows, { windowsCoverage } from "../vitest.windows.config.js";
import migration from "../packs/ship/test-migration.json";

// Historical Windows product inventory excludes tests now owned by the pack lane.
export default defineConfig({ ...windows, test: { ...windows.test,
  include: windowsCoverage.filter(path => !migration.moved.includes(path)),
} });
