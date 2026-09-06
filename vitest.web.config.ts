import base from "./vitest.config.js";
import { defineConfig } from "vitest/config";

// Explicit Chromium lane, run inside the existing Linux job; no silent browser skip.
export default defineConfig({ ...base, test: { ...base.test,
  include: ["packages/cli/test/web.browser.ts"], maxWorkers: 1, testTimeout: 30000,
} });
