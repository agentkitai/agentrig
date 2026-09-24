#!/usr/bin/env node
// Compatibility entry point: implementation is owned by the ship pack.
export * from "../packs/ship/scripts/post-review-comment.mjs";
import { runCli } from "../packs/ship/scripts/post-review-comment.mjs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Eval/embedded consumers need not supply an existing executable path.
// Catch entry resolution only: genuine CLI failures must still propagate.
function entryPath() {
  try { return process.argv[1] ? realpathSync(process.argv[1]) : undefined; }
  catch { return undefined; }
}
const entry = entryPath();

if (entry && import.meta.url === pathToFileURL(entry).href) await runCli();
