#!/usr/bin/env node
// Run after the pack build. Input is conductor-owned captured observations, not child prose.
import { readFile } from "node:fs/promises";
import { childResultSchema, assessChildResult } from "../dist/child-result.js";
const [command, file, ...extra] = process.argv.slice(2);
if (command === "schema" && file === undefined) console.log(JSON.stringify(childResultSchema));
else if (command === "assess" && file && extra.length === 0) {
  const assessment = assessChildResult(JSON.parse(await readFile(file, "utf8")));
  console.log(JSON.stringify(assessment));
  if (assessment.action === "retry" || assessment.action === "halt") process.exitCode = 2;
} else throw new Error("Usage: child-result.mjs schema | assess <conductor-observations.json>");
