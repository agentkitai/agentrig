#!/usr/bin/env node
// Usage: node scripts/post-review-comment.mjs PR REVIEWER MODEL_FILE BODY_FILE HEAD MAIN OUTPUT_FILE [PROOF_FILE]
// The caller must run the existing verdict/stale-head gates before handing us BODY_FILE.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const payload = `${body}${proofFile === undefined ? "" : `\n${proof}`}`;
  // Payload length bounds chunk count; reserve space for its numbered marker.
  const digits = String(payload.length).length;
  const capacity = 60000 - heading.length - 2 - (2 * digits + 7);
  const pieces = [];
  if (`${heading}\n\n${payload}`.length <= 60000) pieces.push(payload);
  else {
    for (let start = 0; start < payload.length;) {
      let end = Math.min(start + capacity, payload.length);
      // Never split a surrogate pair; UTF-16 length is a conservative character bound.
      if (end < payload.length && /[\uD800-\uDBFF]/.test(payload[end - 1])) end--;
      pieces.push(payload.slice(start, end));
      start = end;
    }
  }
  // A receipt is an exclusive attempt lock as well as durable evidence. Refuse
  // every rerun (including uncertain/crashed attempts) rather than duplicate posts.
  const receiptPath = `${outputFile}.receipt.json`;
  if (existsSync(receiptPath)) throw new Error(`refusing rerun; reconcile prior attempt using ${receiptPath}:\n${readFileSync(receiptPath, "utf8")}`);
  const receipt = { pr, heading, total: pieces.length, successful: [], pending: null, status: "posting" };
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  for (const [index, piece] of pieces.entries()) {
    const path = pieces.length === 1 ? outputFile : `${outputFile}.${index + 1}`;
    const marker = pieces.length === 1 ? "" : `(${index + 1}/${pieces.length})\n\n`;
    const comment = `${heading}\n\n${marker}${piece}`;
    if (comment.length > 60000) throw new Error("review comment exceeds limit");
    writeFileSync(path, comment);
    // Assert the exact first line of EVERY emitted body immediately before posting.
    const first = spawnSync("head", ["-1", path], { encoding: "utf8" });
    if (first.status !== 0 || first.stdout !== `${heading}\n`) throw new Error("canonical first-line assertion failed");
    receipt.pending = index + 1;
    save();
    const posted = spawnSync("gh", ["pr", "comment", pr, "--body-file", path], { stdio: "inherit" });
    if (posted.error || posted.status !== 0) {
      receipt.status = "failed";
      save();
      console.error(`partial post: ${receipt.successful.length}/${receipt.total}; successful chunk indices ${JSON.stringify(receipt.successful)}; receipt ${receiptPath}; failed/uncertain chunk ${receipt.pending}; refusing automatic retry`);
      if (posted.error) console.error(posted.error.message);
      process.exitCode = posted.status || 2;
      break;
    }
    receipt.successful.push(index + 1);
    receipt.pending = null;
    receipt.status = receipt.successful.length === receipt.total ? "complete" : "posting";
    save();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
