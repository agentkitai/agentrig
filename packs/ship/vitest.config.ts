import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

// Explicit ownership boundary: product discovery never includes this lane.
export default defineConfig({ ...base, test: { ...base.test,
  include: ["packs/ship/test/**/*.test.ts"],
} });
