import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ProviderConformance, tokensFromEnvValue } from "@agentkitai/agentrig-core";
import type { ProviderEntry } from "./config.js";

const MAX_BYTES = 131_072;
const TTL = 24 * 60 * 60_000;
const Entry = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), report: ProviderConformance }).strict();
const Cache = z.object({ version: z.literal(1), entries: z.array(Entry).max(64) }).strict();
export const providerProbeCachePath = (home = homedir()) => join(home, ".agentrig", "provider-probes.json");

function readBounded(path: string, max = MAX_BYTES): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > max) throw Error("cache bounds");
    const bytes = Buffer.alloc(max + 1); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (n === 0) break; used += n; }
    if (used > max) throw Error("cache bounds"); return bytes.subarray(0, used).toString("utf8");
  } finally { closeSync(fd); }
}
function entries(path: string): z.infer<typeof Entry>[] {
  try { return Cache.parse(JSON.parse(readBounded(path))).entries; } catch { return []; }
}
export function readProviderProbe(path: string, fingerprint: string, now = Date.now()): ProviderConformance | undefined {
  const report = entries(path).find(e => e.fingerprint === fingerprint)?.report;
  return report !== undefined && report.observedAt <= now && now - report.observedAt <= TTL ? report : undefined;
}
export async function writeProviderProbe(path: string, fingerprint: string, report: ProviderConformance): Promise<void> {
  const item = Entry.parse({ fingerprint, report });
  const retained = entries(path).filter(e => e.fingerprint !== fingerprint && e.report.observedAt <= report.observedAt && report.observedAt - e.report.observedAt <= TTL);
  retained.sort((a, b) => b.report.observedAt - a.report.observedAt);
  const body = JSON.stringify(Cache.parse({ version: 1, entries: [item, ...retained.slice(0, 63)] }));
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("provider probe cache limit");
  const dir = dirname(path); await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.provider-probe-${randomUUID()}.tmp`);
  try { await writeFile(temp, body, { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

/** Only the digest is stored. Raw endpoint/credentials/config never enter cache/report output. */
export function providerProbeFingerprint(entry: ProviderEntry, env = process.env): string | undefined {
  let credential: string;
  if (entry.provider === "anthropic") credential = env.ANTHROPIC_API_KEY ?? "";
  else if (entry.provider === "openai") credential = env.OPENAI_API_KEY ?? "";
  else {
    // Read only: do not construct auth or refresh a token for a cache lookup.
    let tokens;
    try { tokens = tokensFromEnvValue(readBounded(env.AGENTRIG_OPENAI_CHATGPT_AUTH ?? join(homedir(), ".agentrig", "openai-chatgpt-auth.json"), 65_536)); } catch { /* env fallback matches auth store */ }
    tokens ??= tokensFromEnvValue(env.AGENTRIG_OPENAI_CHATGPT_TOKEN ?? "");
    if (tokens === null || tokens === undefined) return undefined;
    credential = JSON.stringify(tokens);
  }
  return createHash("sha256").update(JSON.stringify({ version: 1, provider: entry.provider, model: entry.model,
    baseUrl: entry.baseUrl ?? ({ anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1", "openai-chatgpt": "https://chatgpt.com/backend-api/codex" }[entry.provider]),
    contextWindow: entry.contextWindow ?? null, reasoningEffort: entry.reasoningEffort ?? null, credential })).digest("hex");
}
