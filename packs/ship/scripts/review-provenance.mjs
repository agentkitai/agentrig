#!/usr/bin/env node
// Adapter-owned evidence survives scratch/worktree cleanup. The PR stores the
// receipt locator AND digest; prose/model claims alone cannot recreate evidence.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVerdict, receiptTransport } from "./review-verdict.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
export function reviewIdentity(env = process.env) {
  const repository = env.AGENTRIG_REVIEW_REPOSITORY;
  const pr = env.AGENTRIG_REVIEW_PR;
  const pass = env.AGENTRIG_REVIEW_PASS;
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      repository.split("/").some(x => x === "." || x === "..") ||
      !/^[1-9][0-9]*$/.test(pr ?? "") || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pass ?? "")) {
    throw new Error("set AGENTRIG_REVIEW_REPOSITORY=owner/repo, AGENTRIG_REVIEW_PR and unique AGENTRIG_REVIEW_PASS before review");
  }
  return { repository, pr, pass };
}
export function persistReview(identity, provenance, output) {
  // Never use TMPDIR, OUT or a checkout. Exclusive per-attempt files also retain
  // superseded passes; no cleanup helper is intentionally provided.
  const dir = join(homedir(), ".agentrig", "review-evidence", ...identity.repository.split("/"), identity.pr, identity.pass, randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outputPath = join(dir, "review.md");
  const receiptPath = join(dir, "provenance.json");
  const receipt = JSON.stringify({ ...provenance, schema: 1, ...identity, outputSha256: hash(output) }, null, 2) + "\n";
  writeFileSync(outputPath, output, { flag: "wx", mode: 0o600 });
  writeFileSync(receiptPath, receipt, { flag: "wx", mode: 0o600 });
  return { receipt: receiptPath, output: outputPath, sha256: hash(receipt) };
}
export function validateReview(receiptPath, digest, expected) {
  const raw = readFileSync(receiptPath);
  if (!/^[a-f0-9]{64}$/.test(digest ?? "") || hash(raw) !== digest) throw new Error("durable receipt digest mismatch");
  const receipt = JSON.parse(raw);
  if (receipt.schema !== 1) throw new Error("unsupported durable receipt schema");
  for (const key of ["repository", "pr", "pass", "reviewedHead", "slot", "model", "adapter"]) {
    if (!expected[key] || receipt[key] !== expected[key]) throw new Error(`durable receipt ${key} mismatch`);
  }
  const output = readFileSync(join(dirname(receiptPath), "review.md"), "utf8");
  if (hash(output) !== receipt.outputSha256) throw new Error("durable output digest mismatch");
  const binding = { ...expected, assertedModel: expected.model,
    transportModel: ["codex-cli", "claude-cli"].includes(receipt.adapter) ? receipt.transportModel : undefined };
  const verdict = parseVerdict(output, binding);
  const transportModel = receiptTransport(receipt, binding, verdict, expected.adapter);
  return { output, receipt, transportModel };
}
export function runCli() {
  try {
    const [path, digest, repository, pr, pass, reviewedHead, slot, model, adapter, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error("unexpected provenance arguments");
    const result = validateReview(path, digest, { repository, pr, pass, reviewedHead, slot, model, adapter });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) { runCli(); }
