#!/usr/bin/env node
/** Skill-side adapter descriptions. No check execution and no core dependency. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfigText } from "../packages/cli/dist/config.js";

export function declaredSlots(configPath = ".agentrig/config.json", profile) {
  let text;
  try { text = readFileSync(configPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; text = "{}"; }
  const config = parseConfigText(configPath, text);
  if (profile !== undefined && !Object.hasOwn(config.profiles ?? {}, profile)) throw new Error("unknown review profile");
  const layer = profile === undefined ? undefined : config.profiles[profile];
  return { slots: layer?.reviewers ?? config.reviewers ?? [], providers: { ...config.providers, ...layer?.providers } };
}
export const adapters = {
  "claude-cli": {
    launch: "env -u CLAUDECODE claude --model <MODEL> --print --output-format json --permission-mode dontAsk --allowedTools 'Read,Grep,Glob,Bash,Edit,Write' --disallowedTools 'Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)' --no-session-persistence <PROMPT> < /dev/null",
    modelAssertion: "JSON modelUsage: exactly one model key; compare with configured pin",
    failureDetection: "nonzero launch exit, malformed JSON, is_error, empty result or missing modelUsage",
  },
  "codex-cli": {
    launch: "codex exec --model <MODEL> --full-auto <PROMPT> < /dev/null",
    modelAssertion: "captured stderr startup banner model: field; compare with configured pin (do not use --json, which suppresses the banner)",
    failureDetection: "nonzero launch exit, ERROR in stderr, empty stdout final verdict or missing model banner",
  },
  api: {
    launch: "agentrig run --profile <REVIEW_PROFILE> --json <PROMPT> (profile roles.main references slot.provider; model equals slot.model)",
    modelAssertion: "session.start provider/model metadata must match the referenced providers entry and declared pin; refuse provider.switched or auxiliary model provenance",
    failureDetection: "nonzero launch exit, malformed JSONL, missing session.end reason done, missing model metadata or empty final assistant message.append verdict",
  },
};
export function describe(slot, providers = {}) {
  const adapter = adapters[slot.adapter];
  if (!adapter) throw new Error("unknown adapter");
  if (slot.adapter === "api" && providers[slot.provider]?.model !== slot.model)
    throw new Error("API provider model does not match review pin");
  return { slot: slot.name, adapter: slot.adapter, model: slot.model, ...(slot.adapter === "api" ? { provider: slot.provider } : {}), ...adapter };
}
export function validateVerdict(text, head) {
  if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error("invalid review head");
  const claims = [...text.replace(/[`*_]/g, "").matchAll(/\b(?:headsha|head|reviewed)(?:\s+(?:SHA|commit|head|at))*\s*[:=]?\s*([0-9a-f]{7,}|HEAD)\b/gi)];
  if (!claims.length || claims.some(match => !head.toLowerCase().startsWith(match[1].toLowerCase()))) throw new Error("missing or stale reviewed head claim");
  const body = text.replace(/^(?:[ \t]*\r?\n|## External review[^\n]*(?:\n|$))*/, "");
  if (!body.trim() || body.trim().split(/\r?\n/).every(line => !line.trim() || /^#+(?:\s|$)/.test(line))) throw new Error("empty verdict");
  return text;
}
export function assertCliResult(slot, output, banner = "", exitCode = 0) {
  if (exitCode !== 0) throw new Error("review launch failed");
  let model, verdict;
  if (slot.adapter === "claude-cli") {
    const result = JSON.parse(output);
    if (result.is_error === true || typeof result.result !== "string") throw new Error("failed result");
    const models = Object.keys(result.modelUsage ?? {});
    if (models.length !== 1) throw new Error("ambiguous model provenance");
    model = models[0]; verdict = result.result;
  } else if (slot.adapter === "codex-cli") {
    if (/^\s*ERROR\b/im.test(banner)) throw new Error("failed result");
    verdict = output;
    const models = [...banner.matchAll(/^model:\s*(\S+)\s*$/gm)].map(match => match[1]);
    if (models.length !== 1) throw new Error("missing or ambiguous model banner");
    model = models[0];
  } else throw new Error("not a CLI adapter");
  if (model !== slot.model) throw new Error("actual model differs from configured pin");
  if (typeof verdict !== "string" || verdict.trim().length === 0) throw new Error("empty review");
  return { slot: slot.name, adapter: slot.adapter, model, verdict };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { slots, providers } = declaredSlots(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(slots.map(slot => describe(slot, providers)), null, 2));
}
