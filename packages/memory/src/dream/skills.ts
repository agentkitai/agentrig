import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import type { RawStore, WikiPage } from "../types.js";
import type { ScanOptions } from "../scan.js";
import type { MaintenanceRun } from "../maintenance.js";
import { withMemoryLock } from "../lock.js";
import { readBoundedFile } from "../bounded-file.js";
import { loadPromotionEvidence } from "./evidence.js";
import { sessionEvidence } from "./promote.js";
import { detectProcedureCandidates, refineProcedureCandidates, type ProcedureDetection } from "./procedures.js";
import { checkPromotionGuardrails, type PromotionGuardrailIndex } from "./guardrails.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_FILE = 64 * 1024;
const CONTENT = /^  agentrig-content: "([a-f0-9]{64})"\n/m;
export interface SkillEmissionOptions { root: string; apply?: string }
export interface SkillProposal { name: string; path: string; text: string }
export interface SkillEmissionReport {
  digest: string;
  proposals: SkillProposal[];
  status: "preview" | "applied" | "refused";
  reason?: string;
  written: string[];
  preserved: Array<{ path: string; reason: string }>;
}

/** Serializer intentionally independent of core runtime; CLI tests verify the shared format. */
function proposal(candidate: ProcedureDetection["candidates"][number], root: string, dream: string): SkillProposal {
  const artifact = candidate.artifact;
  const slug = basename(artifact.from, ".md").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "procedure";
  const name = `${slug}-${hash(artifact.from).slice(0, 12)}`;
  const metadata: Record<string, string> = {
    "agentrig-schema": "1", "agentrig-generated": "true",
    "agentrig-sessions": JSON.stringify([...new Set(artifact.publicationSources)].sort()),
    "agentrig-page": artifact.from, "agentrig-dream": dream,
    "agentrig-evidence": hash(JSON.stringify({ evidence: artifact.evidence, claims: artifact.claims })), locked: "false",
  };
  if (metadata["agentrig-sessions"]!.length > 8192 || artifact.from.length > 1024 || dream.length > 128) throw new Error("skill provenance limit exceeded");
  // Scope comes from an exact H4-backed claim, never an invented applicability description.
  const description = candidate.scope.map(claim => claim.claim).join("; ");
  if (description.length > 1024) throw new Error("skill description limit exceeded");
  const head = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nmetadata:\n`
    + Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("");
  const unsigned = `${head}---\n${artifact.publicationBody.trim()}\n`;
  const text = `${head}  agentrig-content: "${hash(unsigned)}"\n---\n${artifact.publicationBody.trim()}\n`;
  if (Buffer.byteLength(text) > MAX_FILE || Buffer.byteLength(head) > 16000) throw new Error("generated skill file limit exceeded");
  return { name, path: join(resolve(root), name, "SKILL.md"), text };
}

/** Only timestamp/owner bookkeeping is excluded; content hashes are deterministically derived. */
function reviewDigest(proposals: SkillProposal[]): string {
  return hash(JSON.stringify(proposals.map(item => ({ ...item, text: item.text.replace(CONTENT, "")
    .replace(/^  agentrig-dream: ".*"\n/m, "") }))));
}

async function safeDirectories(path: string, base: string, create: boolean, signal: AbortSignal): Promise<void> {
  const absolute = resolve(path);
  const inside = relative(base, absolute);
  if (inside.startsWith("..") || resolve(base, inside) !== absolute) throw new Error("skill destination escaped the approved memory directory");
  let current = base;
  for (const component of inside.split(/[\\/]/).filter(Boolean)) {
    signal.throwIfAborted(); current = join(current, component);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`skill destination is not an unlinked directory: ${current}`);
  }
}

async function existing(path: string, signal: AbortSignal): Promise<string | undefined> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (stat === undefined) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("occupied destination is not a single regular file");
  return (await readBoundedFile(path, MAX_FILE, signal)).toString("utf8");
}

function owned(text: string, item: SkillProposal): boolean {
  const digest = CONTENT.exec(text);
  if (digest === null || hash(text.replace(CONTENT, "")) !== digest[1]) return false;
  // Fail closed for foreign dialects, locks (including malformed lock values), duplicate keys
  // and noncanonical metadata. A hash is edit detection, not a signature against hostile writers.
  const lines = text.split("\n"); const closing = lines.indexOf("---", 1);
  if (closing < 0 || closing > 64 || lines[0] !== "---" || lines[1] !== `name: ${JSON.stringify(item.name)}`
    || !/^description: ".*"$/.test(lines[2] ?? "") || lines[3] !== "metadata:") return false;
  const keys = new Set<string>(); const values: Record<string, string> = {};
  for (const line of lines.slice(4, closing)) {
    const match = /^  ([a-z-]+): (".*")$/.exec(line);
    if (!match || keys.has(match[1]!)) return false;
    keys.add(match[1]!);
    try { const value: unknown = JSON.parse(match[2]!); if (typeof value !== "string") return false; values[match[1]!] = value; } catch { return false; }
  }
  return [...keys].sort().join(",") === "agentrig-content,agentrig-dream,agentrig-evidence,agentrig-generated,agentrig-page,agentrig-schema,agentrig-sessions,locked"
    && values["agentrig-schema"] === "1" && values["agentrig-generated"] === "true" && values.locked === "false"
    && item.text.includes(`  agentrig-page: ${JSON.stringify(values["agentrig-page"])}\n`);
}

/** Called only after fresh evidence, exact effect receipts and explicit digest confirmation.
 * Cooperative writers are serialized. Noncooperating filesystem writers remain a documented
 * race; the final byte/ownership recheck is edit preservation, not an OS compare-and-swap. */
async function writeProposals(report: SkillEmissionReport, opts: SkillEmissionOptions, base: string, run: MaintenanceRun, lockTimeoutMs: number): Promise<void> {
  await safeDirectories(opts.root, base, true, run.signal);
  await withMemoryLock(opts.root, async () => {
    for (const item of report.proposals) {
      run.check();
      let prior: string | undefined;
      try {
        const directoryExists = await lstat(dirname(item.path)).then(() => true).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false; throw error;
        });
        await safeDirectories(dirname(item.path), base, true, run.signal);
        prior = await existing(item.path, run.signal);
        if (directoryExists && prior === undefined) throw new Error("occupied skill directory without owned SKILL.md preserved");
        if (prior !== undefined && !owned(prior, item)) throw new Error("locked, edited, malformed or foreign skill preserved");
      } catch (error) {
        run.check(); report.preserved.push({ path: item.path, reason: String(error) }); continue;
      }
      const temp = join(dirname(item.path), `.skill-${randomUUID()}.tmp`);
      try {
        if (prior === undefined) {
          run.check(); await writeFile(item.path, item.text, { flag: "wx", mode: 0o600 });
        } else {
          await writeFile(temp, item.text, { flag: "wx", mode: 0o600 });
          await safeDirectories(dirname(item.path), base, false, run.signal);
          if (await existing(item.path, run.signal) !== prior) throw new Error("skill changed during regeneration; preserved");
          run.check(); await rename(temp, item.path);
        }
        report.written.push(item.path);
      } catch (error) {
        run.check(); report.preserved.push({ path: item.path, reason: String(error) });
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    }
  }, { signal: run.signal, timeoutMs: lockTimeoutMs });
  report.status = report.preserved.length === 0 ? "applied" : "refused";
  if (report.preserved.length > 0) report.reason = "one or more destinations preserved; inspect per-file outcomes (no batch rollback)";
}

/** No report input: derive candidates anew from pages and opaque runtime-backed raw evidence. */
export async function prepareProcedureSkills(pages: WikiPage[], raw: RawStore, opts: SkillEmissionOptions,
  run: MaintenanceRun, context: ScanOptions & { provider?: ModelProvider; dream: string; lockTimeoutMs: number; memoryRoot: string; minSessions?: number }): Promise<{ procedures: ProcedureDetection; emission: SkillEmissionReport }> {
  if (resolve(opts.root) !== resolve(context.memoryRoot, "skills", "generated")) throw new Error("skill output must be skills/generated under the approved memory directory");
  // The caller explicitly chose this memory root; canonicalize its OS/user aliases once. Every
  // generated subtree component remains untrusted and is checked without following symlinks.
  const base = await realpath(context.memoryRoot);
  opts = { ...opts, root: join(base, "skills", "generated") };
  const evidenceIndex = await loadPromotionEvidence(raw, pages.flatMap(page => sessionEvidence(page).map(ref => ref.slice(8))), { ...context, signal: run.signal });
  const candidates = detectProcedureCandidates(pages, { evidenceIndex, signal: run.signal,
    ...(context.minSessions === undefined ? {} : { minSessions: context.minSessions }) });
  let receipts: PromotionGuardrailIndex | undefined;
  const procedures = context.provider === undefined ? { candidates, rejected: [] } :
    await refineProcedureCandidates(candidates, context.provider, run, value => { receipts = value; });
  const proposals = procedures.candidates.map(candidate => proposal(candidate, opts.root, context.dream));
  const emission: SkillEmissionReport = { digest: reviewDigest(proposals), proposals, status: "preview", written: [], preserved: [] };
  if (opts.apply !== undefined) {
    let reason: string | undefined;
    if (opts.apply !== emission.digest) reason = "review digest does not match fresh skill proposal; review again";
    else if (proposals.length === 0) reason = "no eligible procedure skills";
    else if (procedures.refinementError !== undefined) reason = `fresh procedure review failed: ${procedures.refinementError}`;
    else if (procedures.candidates.some(candidate => checkPromotionGuardrails(receipts, candidate.artifact).status !== "allow")) reason = "fresh model/effect review required; no skill emitted";
    if (reason !== undefined) { emission.status = "refused"; emission.reason = reason; }
    else await writeProposals(emission, opts, base, run, context.lockTimeoutMs);
  }
  run.check(); return { procedures, emission };
}
