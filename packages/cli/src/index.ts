#!/usr/bin/env node
import { buildProgram } from "./program.js";

import { profileChildEnvironment } from "./child-env.js";

const program = buildProgram();
program.hook("preAction", async (_program, command) => {
  const profile = (command.optsWithGlobals() as { profile?: string }).profile;
  if (profile !== undefined) process.env.AGENTRIG_CHILD_PROFILE = profile;
  Object.assign(process.env, await profileChildEnvironment(process.cwd(), profile));
});
void program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Error && error.name === "AbortError" ? 130 : 1;
});
