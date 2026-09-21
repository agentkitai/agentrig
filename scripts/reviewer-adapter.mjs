#!/usr/bin/env node
// Skill-side external-review adapter. Vendor details stay here and in config, never in role skills.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fail = message => { console.error(message); process.exit(2); };
const [configPath, slotText, worktree, baseRef, briefFile, rawFile, modelFile] = process.argv.slice(2);
if (![configPath, slotText, worktree, baseRef, briefFile, rawFile, modelFile].every(Boolean)) fail("usage: reviewer-adapter CONFIG SLOT WORKTREE BASE BRIEF RAW MODEL_RECEIPT");
let config;
try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { fail("invalid reviewer config"); }
const index = Number(slotText);
const slot = config.reviewers?.[index];
if (!Number.isInteger(index) || index < 0 || index > 1 || !slot) fail("missing declared reviewer slot");
if (!slot.name || !slot.adapter || !slot.model || Object.hasOwn(slot, "canRunChecks")) fail("invalid reviewer slot");
const brief = readFileSync(briefFile, "utf8");
let command; let args; let assertion;
if (slot.adapter === "claude-cli") {
  command = "claude";
  args = ["-p", "--model", slot.model, "--permission-mode", "dontAsk", "--allowedTools", "Read,Grep,Glob,Bash,Edit,Write", "--disallowedTools", "Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)", "--output-format", "json", brief];
  assertion = output => {
    let data; try { data = JSON.parse(output); } catch { fail("adapter output is not JSON"); }
    const models = Object.keys(data.modelUsage ?? {});
    if (models.length !== 1 || models[0] !== slot.model) fail("JSON modelUsage does not match configured pin");
    return typeof data.result === "string" ? data.result : "";
  };
} else if (slot.adapter === "codex-cli") {
  command = "codex";
  args = ["review", "--base", baseRef];
  assertion = (output, stderr) => {
    const models = [...stderr.matchAll(/^model:[ \\t]*(.*)$/gm)].map(match => match[1].trim());
    if (models.length !== 1 || models[0] !== slot.model) fail("stderr model banner does not match configured pin");
    return output;
  };
} else if (slot.adapter === "api") {
  const entry = config.providers?.[slot.provider];
  if (!entry || entry.model !== slot.model) fail("API adapter must bind an existing provider entry with the same model pin");
  // API routing remains owned by AgentRig's named-provider path; this adapter does not copy endpoint/provider logic.
  command = process.execPath;
  args = ["packages/cli/dist/index.js", "run", "--provider-entry", slot.provider, brief];
  assertion = output => output;
} else fail("unknown reviewer adapter id");
const result = spawnSync(command, args, { cwd: worktree, encoding: "utf8", env: process.env });
if (result.error || result.status !== 0) fail(`review adapter failed (${result.status ?? result.error?.message})`);
const body = assertion(result.stdout, result.stderr);
if (!body.trim()) fail("review adapter produced an empty review");
writeFileSync(rawFile, body);
writeFileSync(modelFile, `${slot.model}\n`);
