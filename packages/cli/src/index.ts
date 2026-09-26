#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProgram } from "./program.js";

export { buildProgram, type ProgramDependencies } from "./program.js";
export type { CliPack, CliPackCommand } from "./cli-packs.js";
export { buildRoleProvider, buildProviders, resolveProviderEntries } from "./provider.js";
export type { ProviderOptions, ProviderHooks, ProviderSet } from "./provider.js";
export { resolveChildEnvironment, reviewerHome } from "./child-env.js";
export { resolveProjectChecks } from "./project-checks.js";
export { parseConfigText, readConfigFile } from "./config.js";
export type { ConfigReadOptions, PackConfigRegistration, ConfigFile, ProjectChecks, Role, ProviderEntry, Roles } from "./config.js";

// The package root is also the executable. Importing it must never parse host argv.
// Resolve symlinks so package-manager bin links retain normal CLI behavior.
let invoked: string | undefined;
try { invoked = process.argv[1] ? realpathSync(process.argv[1]) : undefined; } catch { /* not main */ }
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  void buildProgram().parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof Error && error.name === "AbortError" ? 130 : 1;
  });
}

export { readProjectConfig, projectConfigPath } from "./project-config.js";
