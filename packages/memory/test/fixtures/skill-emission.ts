import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, FileRawStore, PROMOTION_EFFECTS } from "@agentkitai/agentrig-memory";

export async function skillFixture(mode = "independent") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-skill-emission-")));
  const lines = ["Scope: Local release verification", "Step 1: Inspect the changed files", "Step 2: Run the applicable tests",
    "Step 3: Request independent review", "Limitation: Deployment requires separate approval"];
  const logs = new SessionStore({ root: join(root, "raw/sessions") });
  for (const id of mode === "single" ? ["s1"] : ["s1", "s2"]) {
    if (mode === "fork" && id === "s2") { await logs.append(id, { type: "session.fork", parent: "s1", atSeq: 2 }); continue; }
    await logs.append(id, { type: "session.start", task: "observe", cwd: root, provider: "fixture", model: "fixture" });
    await logs.append(id, { type: "tool.call", id: "call", name: "bash", input: {}, inputHash: "fixture" });
    await logs.append(id, { type: "tool.result", id: "call", ok: true, display: `${mode === "copied" ? "same" : id}\n${lines.join("\n")}`, durationMs: 0 });
    await logs.append(id, { type: "session.end", reason: "done" });
  }
  const wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init();
  await wiki.write("concepts/release.md", { body: lines.map(claim => `- [observed] ${claim} (session:s1, session:s2)`).join("\n"),
    frontmatter: { type: "concept", slug: "release", aliases: [], confidence: "high", sources: ["session:s1", "session:s2"], updated: "2026-09-06" } });
  return { root, wiki, raw: new FileRawStore({ root }), skills: join(root, "skills/generated") };
}

export function skillProvider(fault?: string): ModelProvider {
  return { id: "fixture", model: "skill", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) {
      let result: unknown = {};
      if (request.system.startsWith("Refine proposed")) {
        result = { candidates: [{ candidateIndex: 0, repeatable: fault !== "nonrepeatable" }] };
        if (fault === "rewrite") result = { candidates: [{ candidateIndex: 0, repeatable: true, steps: ["invented"] }] };
      } else if (request.system.startsWith("Assess the FUTURE EFFECT")) {
        if (fault === "timeout") await new Promise(() => {});
        const candidates = JSON.parse((request.messages[0]!.content[0] as { text: string }).text) as Array<{ candidateIndex: number; claims: Array<{ claimIndex: number }> }>;
        result = { assessments: candidates.map(candidate => ({ candidateIndex: candidate.candidateIndex,
          claims: candidate.claims.map(claim => ({ claimIndex: claim.claimIndex,
            effects: Object.fromEntries(PROMOTION_EFFECTS.map(effect => [effect, fault === "unsafe" ? "weakens" : "preserves"])), reason: "fixture only" })) })) };
      }
      yield { type: "text_delta", text: JSON.stringify(result) };
      yield { type: "usage", usage: { input: 10, output: 5 } };
      yield { type: "stop", reason: "end_turn" };
    } };
}
