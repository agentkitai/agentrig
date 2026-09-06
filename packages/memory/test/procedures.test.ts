import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore, type AuxiliaryReport, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { detectProcedureCandidates, FileMemoryStore, FileRawStore, loadPromotionEvidence, PROMOTION_EFFECTS, renderReport, runDream,
  type PromotionEvidenceIndex } from "@agentkitai/agentrig-memory";

const claims = ["Scope: Local release validation only", "Step 1: Inspect the changed files", "Step 2: Run the applicable tests",
  "Step 3: Request review of the tested revision", "Limitation: Not a substitute for deployment approval"];
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mode = "independent", lines = claims) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-procedures-")); roots.push(root);
  const logs = new SessionStore({ root: join(root, "raw/sessions") });
  for (const id of mode === "single" ? ["s1"] : ["s1", "s2"]) {
    if (mode === "fork" && id === "s2") {
      await logs.append(id, { type: "session.fork", parent: "s1", atSeq: 2 });
      continue;
    }
    await logs.append(id, { type: "session.start", task: `observe ${id}`, cwd: root, provider: "fixture", model: "fixture" });
    await logs.append(id, { type: "tool.call", id: "call", name: "bash", input: {}, inputHash: "fixture" });
    await logs.append(id, { type: "tool.result", id: "call", ok: true, display: `${mode === "copied" ? "same" : id}\n${lines.join("\n")}`, durationMs: 0 });
    await logs.append(id, { type: "session.end", reason: "done" });
  }
  const wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init();
  const page = { path: "concepts/release.md", body: lines.map(claim => `- [observed] ${claim} (session:s1, session:s2)`).join("\n"),
    frontmatter: { type: "concept" as const, slug: "release", aliases: [], confidence: "high" as const, sources: ["session:s1", "session:s2"], updated: "2026-09-06" }, updatedAt: 0 };
  await wiki.write(page.path, page);
  const raw = new FileRawStore({ root });
  return { root, raw, wiki, page };
}
function provider(fault?: string): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { requests, id: "fixture", model: "procedure", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request, signal) {
      requests.push(request);
      let result: unknown = {};
      if (request.system.startsWith("Refine proposed")) {
        if (fault === "abort") { signal.throwIfAborted(); await new Promise(() => {}); }
        const candidates = JSON.parse((request.messages[0]!.content[0] as { text: string }).text) as Array<{ candidateIndex: number }>;
        result = { candidates: candidates.map(candidate => ({ candidateIndex: candidate.candidateIndex, repeatable: fault !== "nonrepeatable" })) };
        if (fault === "rewrite") result = { candidates: [{ candidateIndex: 0, repeatable: true, steps: ["Fabricated procedure"] }] };
        if (fault === "missing") result = { candidates: [] };
        if (fault === "duplicate") result = { candidates: [{ candidateIndex: 0, repeatable: true }, { candidateIndex: 0, repeatable: true }] };
      } else if (request.system.startsWith("Assess the FUTURE EFFECT")) {
        const candidates = JSON.parse((request.messages[0]!.content[0] as { text: string }).text) as Array<{ candidateIndex: number; claims: Array<{ claimIndex: number }> }>;
        result = { assessments: candidates.map(candidate => ({ candidateIndex: candidate.candidateIndex, claims: candidate.claims.map(claim => ({ claimIndex: claim.claimIndex,
          effects: Object.fromEntries(PROMOTION_EFFECTS.map(effect => [effect, fault === "unsafe" && effect === "weaken-verification" ? "weakens" : "preserves"])), reason: "scripted behavioral assessment",
        })) })) };
      }
      yield { type: "text_delta", text: JSON.stringify(result) };
      yield { type: "usage", usage: { input: 10, output: 5 } };
      yield { type: "stop", reason: "end_turn" };
    } };
}

it("actual structural dream yields exactly one witnessed three-step candidate and changes no source content", async () => {
  const f = await fixture(); const model = provider();
  const paths = [join(f.wiki.root, f.page.path), join(f.root, "raw/sessions/s1.jsonl"), join(f.root, "raw/sessions/s2.jsonl")];
  const before = await Promise.all(paths.map(path => readFile(path, "utf8")));
  const pagePaths = (await f.wiki.pages()).map(page => page.path);
  const result = await runDream({ ...f, provider: model, structuralOnly: true, procedureCandidates: true });
  try {
    expect(result.report.procedures?.candidates).toHaveLength(1);
    const candidate = result.report.procedures!.candidates[0]!;
    expect(candidate.status).toBe("structural-unassessed"); expect(candidate.steps).toHaveLength(3);
    for (const claim of [...candidate.steps, ...candidate.scope, ...candidate.limitations]) {
      expect(claim.eligible).toBe(true); expect(claim.witnesses).toHaveLength(2);
      expect(new Set(claim.witnesses.map(witness => witness.family)).size).toBe(2);
      for (const witness of claim.witnesses) expect(witness.excerpt).toBe(claim.claim);
    }
    expect(renderReport(result.report)).toContain("skill-candidate [structural-unassessed]");
    expect(renderReport(result.report)).toContain("fresh evidence/effect review required before emission");
    expect(model.requests).toEqual([]); expect(result.auxiliary?.calls).toEqual([]);
    expect(await Promise.all(paths.map(path => readFile(path, "utf8")))).toEqual(before);
    expect((await f.wiki.pages()).map(page => page.path)).toEqual(pagePaths);
  } finally { await result.workspace.dispose(); }
});

it.each(["single", "fork", "copied"])("actual dream refuses %s-session support", async mode => {
  const f = await fixture(mode); const result = await runDream({ ...f, structuralOnly: true, procedureCandidates: true });
  try { expect(result.report.procedures?.candidates).toEqual([]); } finally { await result.workspace.dispose(); }
});

it("refuses fabricated evidence, absent scope/limitations, extra prose and reordered steps", async () => {
  const f = await fixture(); const evidenceIndex = await loadPromotionEvidence(f.raw, ["s1", "s2"]);
  expect(detectProcedureCandidates([f.page], { evidenceIndex: { kind: "runtime-session-evidence" } as PromotionEvidenceIndex })).toEqual([]);
  for (const body of [f.page.body.replace(/.*Limitation:.*\n?/, ""), f.page.body.replace(/.*Scope:.*\n?/, ""),
    f.page.body + "\nUnsupported scope", f.page.body.replace("Step 2:", "Step 9:"), f.page.body.replace("Local release", "Every deployment")]) {
    expect(detectProcedureCandidates([{ ...f.page, body }], { evidenceIndex })).toEqual([]);
  }
});

it("deduplicates exact procedures on multiple pages without combining unrelated support", async () => {
  const f = await fixture(); const evidenceIndex = await loadPromotionEvidence(f.raw, ["s1", "s2"]);
  const candidates = detectProcedureCandidates([f.page, { ...f.page, path: "concepts/duplicate.md" }], { evidenceIndex });
  expect(candidates).toHaveLength(1); expect(candidates[0]?.pages).toHaveLength(2);
});

it.each([1, 2, 3])("shares classification and effect call limits without raising the ceiling (%s)", async maxCalls => {
  const f = await fixture(); const model = provider();
  const result = await runDream({ ...f, provider: model, procedureCandidates: true, limits: { maxCalls } });
  try {
    expect(model.requests).toHaveLength(maxCalls); expect(result.auxiliary?.calls).toHaveLength(maxCalls);
    expect(result.report.procedures?.candidates).toHaveLength(1);
    expect(result.report.procedures?.candidates[0]?.status).toBe(maxCalls === 3 ? "model-and-effect-reviewed" : "structural-unassessed");
    if (maxCalls < 3) expect(result.report.procedures?.refinementError).toContain("call limit");
    else expect(result.report.procedures?.candidates[0]?.artifact.guardrails?.status).toBe("allow");
  } finally { await result.workspace.dispose(); }
});

it.each(["rewrite", "missing", "duplicate"])("malformed refinement cannot smuggle new instructions: %s", async fault => {
  const f = await fixture(); const result = await runDream({ ...f, provider: provider(fault), procedureCandidates: true, limits: { maxCalls: 3 } });
  try {
    expect(result.report.procedures?.refinementError).toBeTruthy();
    expect(result.report.procedures?.candidates[0]?.status).toBe("structural-unassessed");
    expect(result.report.procedures?.candidates[0]?.artifact.publicationBody).toBe(f.page.body);
    expect(JSON.stringify(result.report.procedures?.candidates)).not.toContain("Fabricated");
  } finally { await result.workspace.dispose(); }
});

it.each(["nonrepeatable", "unsafe"])("refuses %s candidates rather than softening them", async fault => {
  const f = await fixture(); const result = await runDream({ ...f, provider: provider(fault), procedureCandidates: true, limits: { maxCalls: 3 } });
  try { expect(result.report.procedures?.candidates).toEqual([]); expect(result.report.procedures?.rejected).toHaveLength(1); }
  finally { await result.workspace.dispose(); }
});

it("is opt-in and adds no calls to ordinary dreams", async () => {
  const f = await fixture(); const model = provider();
  const result = await runDream({ ...f, provider: model });
  try { expect(result.report.procedures).toBeUndefined(); expect(model.requests).toHaveLength(1); }
  finally { await result.workspace.dispose(); }
});

it("fails the whole structural batch above its cap rather than silently truncating", async () => {
  const groups = Array.from({ length: 17 }, (_, index) => claims.map(claim => `${claim} variant ${index}`));
  const f = await fixture("independent", groups.flat());
  for (const [index, group] of groups.entries()) await f.wiki.write(`concepts/procedure-${index}.md`, {
    ...f.page, body: group.map(claim => `- [observed] ${claim} (session:s1, session:s2)`).join("\n"),
  });
  await expect(runDream({ ...f, structuralOnly: true, procedureCandidates: true })).rejects.toThrow("procedure candidate batch limit");
});

it("propagates cancellation into an in-flight classifier without returning late candidates", async () => {
  const f = await fixture(); const controller = new AbortController(); const base = provider(); let usage: AuxiliaryReport | undefined;
  const model: ModelProvider = { ...base, async *stream(request, signal) {
    if (request.system.startsWith("Refine proposed")) {
      controller.abort(); expect(signal.aborted).toBe(true); await new Promise(() => {});
    } else yield* base.stream(request, signal);
  } };
  await expect(runDream({ ...f, provider: model, signal: controller.signal, procedureCandidates: true, limits: { maxCalls: 3 },
    onUsage: report => { usage = report; } })).rejects.toMatchObject({ name: "AbortError" });
  expect(usage?.calls).toHaveLength(2); expect(usage?.unknownUsageCalls).toBe(1);
});

it("bounds uncooperative refinement and preserves unknown usage", async () => {
  const f = await fixture(); const result = await runDream({ ...f, provider: provider("abort"), procedureCandidates: true, limits: { maxCalls: 3, callTimeoutMs: 20 } });
  try {
    expect(result.report.procedures?.candidates[0]?.status).toBe("structural-unassessed");
    expect(result.report.procedures?.refinementError).toContain("timed out");
    expect(result.auxiliary?.unknownUsageCalls).toBe(1);
  } finally { await result.workspace.dispose(); }
});

it("propagates cancellation during procedure work and reports accounting", async () => {
  const f = await fixture(); const controller = new AbortController(); let usage: AuxiliaryReport | undefined;
  await expect(runDream({ ...f, provider: provider(), procedureCandidates: true, signal: controller.signal,
    onPhase: phase => { if (phase === "skill-candidates") controller.abort(); }, onUsage: report => { usage = report; } })).rejects.toMatchObject({ name: "AbortError" });
  expect(usage?.calls).toHaveLength(1);
  expect(await f.wiki.read(f.page.path)).not.toBeNull();
});
