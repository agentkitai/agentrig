#!/usr/bin/env node
// Usage: node scripts/post-review-comment.mjs PR REVIEWER MODEL_FILE BODY_FILE HEAD MAIN OUTPUT_FILE [PROOF_FILE]
// The caller must run the existing verdict/stale-head gates before handing us BODY_FILE.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

try {
  const args = process.argv.slice(2);
  if (args.length !== 7 && args.length !== 8) throw new Error("expected PR REVIEWER MODEL_FILE BODY_FILE HEAD MAIN OUTPUT_FILE [PROOF_FILE]");
  const [pr, reviewer, modelFile, bodyFile, head, main, outputFile, proofFile] = args;
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Error("invalid PR number");
  if (!["Claude Code", "Codex"].includes(reviewer)) throw new Error("invalid reviewer");
  const model = readFileSync(modelFile, "utf8").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error("empty or invalid model file");
  if (![head, main].every(sha => sha.length === 40 && /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("HEAD and MAIN must be unquoted 40-hex SHAs");
  const raw = readFileSync(bodyFile, "utf8");
  const body = raw.replace(/^(?:[ \t]*\r?\n|## External review[^\n]*(?:\n|$))*/, "");
  if (!body.trim()) throw new Error("empty reviewer body");
  const proof = proofFile === undefined ? "" : readFileSync(proofFile, "utf8");
  if (proofFile !== undefined && !proof.trim()) throw new Error("empty proof file");
  const heading = `## External review — ${reviewer} (${model}) — head ${head} — merged with origin/main ${main} — full`;
  writeFileSync(outputFile, `${heading}\n\n${body}${proofFile === undefined ? "" : `\n${proof}`}`);
  // Keep the same head -1 acceptance, immediately before the only posting call.
  const first = spawnSync("head", ["-1", outputFile], { encoding: "utf8" });
  if (first.status !== 0 || first.stdout !== `${heading}\n`) throw new Error("canonical first-line assertion failed");
  const posted = spawnSync("gh", ["pr", "comment", pr, "--body-file", outputFile], { stdio: "inherit" });
  if (posted.error) throw posted.error;
  process.exitCode = posted.status ?? 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
