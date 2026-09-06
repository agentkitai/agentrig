#!/usr/bin/env node
import { buildProgram } from "./program.js";

void buildProgram().parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Error && error.name === "AbortError" ? 130 : 1;
});
