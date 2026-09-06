import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ConfigValues } from "./config.js";
import { readEvaluationReport } from "./evaluation.js";

const path = z.string().min(1).max(4096);
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SessionEvaluationFixtures = z.object({
  version: z.literal(1), workerImage: image, checkerImage: image,
  sessions: z.array(z.object({
    sessionId, task: z.enum(["A1", "A2", "A3", "A4", "X1", "X2", "X3", "X4"]),
    source: path, baseline: path,
    memory: z.object({ path, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict()).min(1).max(16),
}).strict();

/** Trusted repository evaluator code only; the mapping never selects executable modules. */
export const evaluatorPaths = Object.freeze({
  workspace: fileURLToPath(new URL("../../../eval/workspace.mjs", import.meta.url)),
  check: fileURLToPath(new URL("../../../eval/check.mjs", import.meta.url)),
  tasks: new URL("../../../eval/tasks.mjs", import.meta.url).href,
  support: new URL("../../../eval/live-support.mjs", import.meta.url).href,
});

export async function readFixtureMap(file: string) {
  const absolute = await realpath(file);
  if (!(await lstat(absolute)).isFile()) throw new Error("fixture map must be a regular file");
  const handle = await open(absolute, process.platform === "win32" ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("fixture map must be a regular file");
    const buffer = Buffer.alloc(64 * 1024 + 1); let size = 0;
    while (size < buffer.length) {
      const next = await handle.read(buffer, size, buffer.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > 64 * 1024) throw new Error("fixture map exceeds 64 KiB");
    let map: z.infer<typeof SessionEvaluationFixtures>;
    try { map = SessionEvaluationFixtures.parse(JSON.parse(buffer.subarray(0, size).toString("utf8"))); }
    catch { throw new Error("invalid evaluation fixture map"); }
    if (new Set(map.sessions.map(row => row.sessionId)).size !== map.sessions.length)
      throw new Error("duplicate session fixture mapping");
    const rows = [];
    for (const row of map.sessions) {
      const source = await realpath(resolve(dirname(absolute), row.source));
      const baseline = await realpath(resolve(dirname(absolute), row.baseline));
      const report = await readEvaluationReport(baseline);
      if (report.task !== row.task || report.evidence.logs.filter(log => log.role === "main").length !== 1
        || !report.evidence.logs.some(log => log.role === "main" && log.sessionId === row.sessionId))
        throw new Error("baseline task/main-session identity does not match fixture mapping");
      const memory = row.memory === undefined ? undefined : {
        ...row.memory, path: await realpath(resolve(dirname(absolute), row.memory.path)),
      };
      rows.push({ ...row, source, baseline, report, ...(memory === undefined ? {} : { memory }) });
    }
    return { ...map, sessions: rows };
  } finally { await handle.close(); }
}

const supported = new Set<keyof ConfigValues>([
  "provider", "model", "baseUrl", "contextWindow", "reasoningEffort", "providers", "roles",
  "memory", "system", "supervise", "supervisorAbort", "supervisorSoft",
  "supervisorTurnsRemaining", "supervisorReview", "maxTurns", "maxTokens", "maxMinutes",
  "maxUsd", "priceIn", "priceOut", "priceCacheRead", "priceCacheWrite", "maxTokensPerTurn",
]);
// Produced by the trusted config resolver, not accepted as settings by its strict file schema.
const resolverMetadata = new Set(["profile", "trust", "packageSkillIndex", "extensionCwd", "trustedProjectRoot",
  "modelExplicit", "maxTokensPerTurnExplicit", "providerOverride"]);

/** A deliberately small supported profile, not a silently modified full-harness replay. */
export function validateEvaluationProfile(values: ConfigValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (supported.has(key as keyof ConfigValues) || resolverMetadata.has(key) || value === undefined || value === false
      || (Array.isArray(value) && value.length === 0)) continue;
    // workspace-write is implemented by the fixed isolated worker, never by host execution.
    if (key === "sandbox" && value === "workspace-write") continue;
    throw new Error(`evaluation profile does not support effective field: ${key}`);
  }
  if (values.roles?.memory !== undefined || values.roles?.subagents !== undefined)
    throw new Error("evaluation profile does not support effective field: roles.memory/roles.subagents");
  if (values.system !== undefined && Buffer.byteLength(values.system) > 16 * 1024)
    throw new Error("evaluation profile system exceeds 16 KiB");
  if (values.supervise !== true && [values.supervisorAbort, values.supervisorSoft,
    values.supervisorTurnsRemaining, values.supervisorReview].some(v => v !== undefined && v !== false))
    throw new Error("evaluation profile supervisor settings require supervise");
}
