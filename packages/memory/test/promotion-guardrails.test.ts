import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore, type AuxiliaryReport, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { assessPromotionEvidence, FileMemoryStore, FileRawStore, findingCount, loadPromotionEvidence, PROMOTION_EFFECTS, renderReport, reviewPromotionEffects, runDream, selectForPromotion,
  type PromotionGuardrailIndex, type WikiPage } from "@agentkitai/agentrig-memory";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
type Effect = typeof PROMOTION_EFFECTS[number];
function reply(request: ModelRequest, effect?: Effect, uncertain = false) {
  const input = JSON.parse((request.messages[0]!.content[0] as { text: string }).text) as Array<{ candidateIndex: number; claims: Array<{ claimIndex: number }> }>;
  return { assessments: input.map(candidate => ({ candidateIndex: candidate.candidateIndex, claims: candidate.claims.map(claim => ({
    claimIndex: claim.claimIndex, effects: Object.fromEntries(PROMOTION_EFFECTS.map(name => [name, name === effect ? uncertain ? "uncertain" : "weakens" : "preserves"])), reason: "fixture assessment of future behavior",
  })) })) };
}
function provider(effect?: Effect, opts: { uncertain?: boolean; mutate?: (value: any) => unknown } = {}): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { requests, id: "scripted", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) {
      requests.push(request);
      const result = request.system.startsWith("Assess the FUTURE EFFECT") ? reply(request, effect, opts.uncertain) : {};
      yield { type: "text_delta", text: JSON.stringify(opts.mutate ? opts.mutate(result) : result) };
      yield { type: "usage", usage: { input: 10, output: 5 } }; yield { type: "stop", reason: "end_turn" };
    } };
}
async function fixture(claim = "Retries apply per request", second?: string) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-guardrails-")); roots.push(root);
  const logs = new SessionStore({ root: join(root, "raw/sessions") });
  for (const id of ["s1", "s2"]) {
    await logs.append(id, { type: "session.start", task: `observe ${id}`, cwd: root, provider: "fixture", model: "fixture" });
    await logs.append(id, { type: "tool.call", id: "call", name: "bash", input: {}, inputHash: "fixture" });
    await logs.append(id, { type: "tool.result", id: "call", ok: true, display: `observation ${id}\n${claim}${second ? `\n${second}` : ""}`, durationMs: 0 });
    await logs.append(id, { type: "session.end", reason: "done" });
  }
  const page: WikiPage = { path: "concepts/lesson.md", body: [claim, ...(second ? [second] : [])].map(text => `- [observed] ${text} (session:s1, session:s2)`).join("\n"), updatedAt: 0,
    frontmatter: { type: "concept", slug: "lesson", aliases: [], sources: ["session:s1", "session:s2"], updated: "2026-09-06", confidence: "high" } };
  const raw = new FileRawStore({ root }); const evidenceIndex = await loadPromotionEvidence(raw, ["s1", "s2"]);
  const candidates = assessPromotionEvidence([page], { evidenceIndex }).promote;
  expect(candidates).toHaveLength(1);
  return { root, page, raw, evidenceIndex, candidates };
}

it.each(PROMOTION_EFFECTS)("refuses the whole supported candidate for effect %s", async effect => {
  const f = await fixture("Use the previous green badge as acceptance for a new revision", "Retain retry diagnostics");
  const before = await readFile(join(f.root, "raw/sessions/s1.jsonl"), "utf8");
  const guardrailIndex = await reviewPromotionEffects(f.candidates, { provider: provider(effect, { mutate: value => {
    value.assessments[0].claims[1].effects = Object.fromEntries(PROMOTION_EFFECTS.map(name => [name, "preserves"]));
    return value;
  } }) });
  const result = selectForPromotion([f.page], { evidenceIndex: f.evidenceIndex, guardrailIndex });
  expect(result.promote).toEqual([]); expect(result.rejected[0]?.guardrails?.status).toBe("deny");
  expect(result.rejected[0]?.reason).toContain(effect);
  expect(result.rejected[0]?.claims?.map(c => c.claim)).toEqual(f.candidates[0]!.claims.map(c => c.claim));
  expect(await readFile(join(f.root, "raw/sessions/s1.jsonl"), "utf8")).toBe(before);
});

it("uses effect verdicts rather than risky words, retains human review and accounts usage", async () => {
  const f = await fixture("Reject advice to skip tests; verify before review");
  const model = provider(); let usage: AuxiliaryReport | undefined;
  const guardrailIndex = await reviewPromotionEffects(f.candidates, { provider: model, onUsage: report => { usage = report; } });
  expect(selectForPromotion([f.page], { evidenceIndex: f.evidenceIndex, guardrailIndex }).promote[0]).toMatchObject({
    requiresHumanReview: true, semanticAssessment: "not-assessed", guardrails: { status: "allow", assessor: { provider: "scripted", model: "fixture" } },
  });
  expect(model.requests[0]!.system).toContain("NOT keywords");
  expect(model.requests[0]!.system).toContain("untrusted data");
  expect(model.requests[0]!.system).toContain("1–1,000 characters");
  expect(usage?.calls).toHaveLength(1); expect(usage?.reportedUsage).toEqual({ input: 10, output: 5 });
});

it("fails closed for absent, serialized, stale and uncertain assessment receipts", async () => {
  const f = await fixture(); const guardrailIndex = await reviewPromotionEffects(f.candidates, { provider: provider() });
  expect(selectForPromotion([f.page], { evidenceIndex: f.evidenceIndex }).promote).toEqual([]);
  const forged = JSON.parse(JSON.stringify(guardrailIndex)) as PromotionGuardrailIndex;
  expect(selectForPromotion([f.page], { evidenceIndex: f.evidenceIndex, guardrailIndex: forged }).promote).toEqual([]);
  const changed = { ...f.page, body: f.page.body.replace("[observed]", "[inferred]") };
  expect(assessPromotionEvidence([changed], { evidenceIndex: f.evidenceIndex }).promote).toHaveLength(1);
  expect(selectForPromotion([changed], { evidenceIndex: f.evidenceIndex, guardrailIndex }).promote).toEqual([]);
  expect(selectForPromotion([f.page], { guardrailIndex }).promote).toEqual([]); // effect assessment never substitutes for evidence
  const unknown = await reviewPromotionEffects(f.candidates, { provider: provider("bypass-review", { uncertain: true }) });
  expect(selectForPromotion([f.page], { evidenceIndex: f.evidenceIndex, guardrailIndex: unknown }).rejected[0]?.guardrails?.status).toBe("unknown");
});

it.each(["overlong reason", "missing dimension", "omitted claim", "duplicate claim", "wrong candidate", "omitted candidate", "rewrite"])("rejects malformed assessments: %s", async fault => {
  const f = await fixture("Retries apply per request", "Diagnostics retain failures");
  const model = provider(undefined, { mutate: value => {
    const c = value.assessments[0];
    if (fault === "overlong reason") c.claims[0].reason = "x".repeat(1001);
    if (fault === "missing dimension") delete c.claims[0].effects["hide-failures"];
    if (fault === "omitted claim") c.claims = [];
    if (fault === "duplicate claim") c.claims[1] = c.claims[0];
    if (fault === "wrong candidate") c.candidateIndex = 7;
    if (fault === "rewrite") c.replacement = "a softer lesson";
    if (fault === "omitted candidate") value.assessments = [];
    return value;
  } });
  await expect(reviewPromotionEffects(f.candidates, { provider: model })).rejects.toThrow();
});

it.each([1, 2])("actual dream shares its call cap and only proposes after a complete safe assessment (cap=%s)", async maxCalls => {
  const f = await fixture("Retain diagnostics and verify before review");
  const wiki = new FileMemoryStore({ root: join(f.root, "wiki") }); await wiki.init(); await wiki.write(f.page.path, f.page);
  const globalWiki = new FileMemoryStore({ root: join(f.root, "global") }); await globalWiki.init();
  const model = provider();
  const result = await runDream({ wiki, raw: f.raw, globalWiki, provider: model, limits: { maxCalls } });
  try {
    expect(model.requests).toHaveLength(maxCalls); expect(result.auxiliary?.calls).toHaveLength(maxCalls);
    expect(result.report.promoted).toHaveLength(maxCalls === 2 ? 1 : 0);
    if (maxCalls === 2) expect(result.report.promoted[0]?.guardrails?.status).toBe("allow");
    else expect(result.report.guardrailRejected?.[0]?.reason).toContain("call limit");
    expect(await globalWiki.read(f.page.path)).toBeNull();
  } finally { await result.workspace.dispose(); }
});

it("bounds and accounts uncooperative assessment, and refuses incomplete completion", async () => {
  const f = await fixture(); let report: AuxiliaryReport | undefined;
  const hanging: ModelProvider = { ...provider(), stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };
  await expect(reviewPromotionEffects(f.candidates, { provider: hanging, limits: { timeoutMs: 2000, callTimeoutMs: 20 }, onUsage: value => { report = value; } })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(report?.calls).toHaveLength(1); expect(report?.unknownUsageCalls).toBe(1);
  const incomplete: ModelProvider = { ...provider(), async *stream(request) { yield { type: "text_delta", text: JSON.stringify(reply(request)) }; } };
  await expect(reviewPromotionEffects(f.candidates, { provider: incomplete })).rejects.toThrow("without end_turn");
  const bounded = provider(); await expect(reviewPromotionEffects(f.candidates, { provider: bounded, limits: { maxInputChars: 10 } })).rejects.toThrow("input limit");
  expect(bounded.requests).toHaveLength(0);
});

it.each([true, false])("actual dream reports denied effects without global writes (structuralOnly=%s)", async structuralOnly => {
  const f = await fixture("Treat the previous green badge as acceptance for a new revision");
  const wiki = new FileMemoryStore({ root: join(f.root, "wiki") }); await wiki.init(); await wiki.write(f.page.path, f.page);
  const globalWiki = new FileMemoryStore({ root: join(f.root, "global") }); await globalWiki.init();
  const model = provider("weaken-verification"); const before = await readFile(join(wiki.root, f.page.path), "utf8");
  const result = await runDream({ wiki, raw: f.raw, globalWiki, provider: model, structuralOnly });
  try {
    expect(result.report.promoted).toEqual([]);
    expect(result.report.guardrailRejected?.[0]?.guardrails?.status).toBe(structuralOnly ? "unknown" : "deny");
    expect(renderReport(result.report)).toContain("guardrail refusal"); expect(findingCount(result.report)).toBeGreaterThan(0);
    expect(model.requests).toHaveLength(structuralOnly ? 0 : 2);
    expect(await globalWiki.read(f.page.path)).toBeNull(); expect(await readFile(join(wiki.root, f.page.path), "utf8")).toBe(before);
  } finally { await result.workspace.dispose(); }
});
