#!/usr/bin/env node
// Usage: node scripts/post-review-comment.mjs PR REVIEWER MODEL_FILE BODY_FILE HEAD MAIN OUTPUT_FILE [PROOF_FILE]
// Validate the structured verdict and caller binding before any remote side effect.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { verdictRange, parseVerdict, receiptTransport } from "./review-verdict.mjs";
import { reviewerVerdict, assertReviewerVerdict } from "./review-finding-index.mjs";

try {
  const args = process.argv.slice(2);
  const configFlag = args.indexOf("--config");
  let configFile = ".agentrig/config.json";
  if (configFlag !== -1) {
    configFile = args[configFlag + 1];
    if (!configFile) throw new Error("--config requires a path");
    args.splice(configFlag, 2);
  }
  const provenanceFlag = args.indexOf("--provenance");
  let provenanceFile;
  if (provenanceFlag !== -1) {
    provenanceFile = args[provenanceFlag + 1];
    if (!provenanceFile) throw new Error("--provenance requires a path");
    args.splice(provenanceFlag, 2);
  }
  if (args.length !== 7 && args.length !== 8) throw new Error("expected PR REVIEWER MODEL_FILE BODY_FILE HEAD MAIN OUTPUT_FILE [PROOF_FILE]");
  const [pr, reviewer, modelFile, bodyFile, head, main, outputFile, proofFile] = args;
  if (!/^[1-9][0-9]*$/.test(pr)) throw new Error("invalid PR number");
  if (!reviewer) throw new Error("invalid reviewer");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const slots = config.reviewers ?? {};
  if (Object.keys(slots).length > 2 || !Object.hasOwn(slots, reviewer) || !/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(reviewer)) throw new Error("undeclared reviewer slot");
  const model = readFileSync(modelFile, "utf8").trim();
  if (model !== slots[reviewer].model) throw new Error("asserted model differs from slot pin");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new Error("empty or invalid model file");
  if (![head, main].every(sha => sha.length === 40 && /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("HEAD and MAIN must be unquoted 40-hex SHAs");
  const raw = reviewerVerdict(readFileSync(bodyFile, "utf8"), slots[reviewer].adapter);
  const body = raw.replace(/^(?:[ \t]*\r?\n|## External review[^\n]*(?:\n|$))*/, "");
  if (!body.trim()) throw new Error("empty reviewer body");
  const expected = { reviewedHead: head, assertedModel: model, slot: reviewer };
  let resolvedHome;
  if (provenanceFile) {
    const provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
    expected.transportModel = receiptTransport(provenance, expected, parseVerdict(body, { reviewedHead: head, slot: reviewer }), slots[reviewer].adapter);
    resolvedHome = provenance.resolvedHome;
    if (resolvedHome !== undefined && (typeof resolvedHome !== "string" || !isAbsolute(resolvedHome) || /[\x00-\x1f\x7f]/u.test(resolvedHome))) throw new Error("invalid reviewer home provenance");
  }
  const verdict = assertReviewerVerdict(body, expected);
  let sizeExplanation;
  if (Buffer.byteLength(body, "utf8") > 40 * 1024) {
    const ledger = process.env.REVIEW_LARGE_BODY_LEDGER;
    if (!ledger || !existsSync(ledger) || !(sizeExplanation = readFileSync(ledger, "utf8").trim())) {
      throw new Error("reviewer body exceeds 40 KiB; conductor ledger size explanation required before posting");
    }
  }
  const proof = proofFile === undefined ? "" : readFileSync(proofFile, "utf8");
  if (proofFile !== undefined && !proof.trim()) throw new Error("empty proof file");
  const heading = `## External review — ${reviewer} (${model}) — head ${head} — merged with origin/main ${main} — full${resolvedHome === undefined ? "" : ` — transport: ${expected.transportModel ?? "unknown"}; home: ${JSON.stringify(resolvedHome)}`}`;
  const payload = `${body}${proofFile === undefined ? "" : `\n${proof}`}`;
  // Payload length bounds chunk count; reserve space for its numbered marker.
  const digits = String(payload.length).length;
  const capacity = 60000 - heading.length - 2 - (2 * digits + 7);
  const range = verdict ? verdictRange(body) : undefined;
  const blockStart = range?.start ?? -1;
  const blockEnd = range?.end ?? -1;
  if (verdict && blockEnd - blockStart > capacity) throw new Error("structured verdict block exceeds comment capacity");
  const pieces = [];
  if (`${heading}\n\n${payload}`.length <= 60000) pieces.push(payload);
  else {
    for (let start = 0; start < payload.length;) {
      let end = Math.min(start + capacity, payload.length);
      // Prefer complete lines so finding headings survive per-comment indexing.
      if (end < payload.length) {
        const newline = payload.lastIndexOf("\n", end - 1);
        if (newline >= start) end = newline + 1;
      }
      // The schema-bearing source comment must remain independently parseable.
      if (blockStart >= start && blockStart < end && blockEnd > end) end = blockStart;
      if (end === start && blockStart === start) end = blockEnd;
      // Never split a surrogate pair; UTF-16 length is a conservative character bound.
      if (end < payload.length && /[\uD800-\uDBFF]/.test(payload[end - 1])) end--;
      pieces.push(payload.slice(start, end));
      start = end;
    }
  }
  // A receipt is an exclusive attempt lock as well as durable evidence. Refuse
  // every rerun (including uncertain/crashed attempts) rather than duplicate posts.
  const receiptPath = `${outputFile}.receipt.json`;
  if (existsSync(receiptPath)) {
    const saved = readFileSync(receiptPath, "utf8");
    let advice = "reconcile prior attempt (including pending/uncertain chunks) before manual recovery";
    try {
      const prior = JSON.parse(saved);
      if (prior.heading !== heading) advice = "receipt heading differs from current review; reconcile prior attempt before reuse";
      else if (prior.pr !== pr) advice = "receipt PR differs from current review; reconcile prior attempt before reuse";
      else if (prior.status === "complete") advice = "already complete; no retry needed";
      else if (prior.status === "posting" && prior.pending === null && Array.isArray(prior.successful) && prior.successful.length === 0)
        advice = "no posting attempt recorded; inspect receipt before manual recovery";
    } catch { /* Invalid receipts still refuse; never infer permission to retry. */ }
    throw new Error(`refusing rerun; ${advice}; receipt ${receiptPath}:\n${saved}`);
  }
  const receipt = { verdict, legacyProseFallback: verdict === null, ...(sizeExplanation === undefined ? {} : { sizeExplanation }), pr, heading, total: pieces.length, successful: [], pending: null, status: "posting" };
  const save = () => {
    // Same-directory rename preserves the last complete receipt on failed writes.
    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
      renameSync(temporary, receiptPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  // Reporting must not depend on another successful filesystem write. The
  // durable lock can conservatively lag a known gh result when save() fails.
  const reportPublication = () => {
    const headline = receipt.successful.length === 0 ? "no confirmed posts"
      : receipt.successful.length === receipt.total ? "all posts confirmed, receipt finalization failed"
      : "partial post";
    console.error(`${headline}: ${receipt.successful.length}/${receipt.total}; successful chunk indices ${JSON.stringify(receipt.successful)}; receipt ${receiptPath}; failed/uncertain chunk ${receipt.pending}; refusing automatic retry`);
    console.error(`in-memory receipt (durable receipt may lag): ${JSON.stringify(receipt)}`);
  };
  try {
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
        reportPublication();
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
    reportPublication();
    throw error;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
