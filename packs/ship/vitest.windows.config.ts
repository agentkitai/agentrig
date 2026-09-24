import { defineConfig } from "vitest/config";
import pack from "./vitest.config.js";
import { windowsCoverage } from "../../vitest.windows.config.js";
import migration from "./test-migration.json";

// Preserve the pre-move Windows selection, now in its owning lane.
export default defineConfig({ ...pack, test: { ...pack.test,
  include: windowsCoverage.filter(path => migration.moved.includes(path))
    .map(path => `packs/ship/test/${path.split("/").at(-1)}`),
} });
