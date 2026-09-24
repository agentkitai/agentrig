#!/usr/bin/env node
// Compatibility entry point: implementation is owned by the ship pack.
export * from "../packs/ship/scripts/review-provenance.mjs";
import { runCli } from "../packs/ship/scripts/review-provenance.mjs";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli();
