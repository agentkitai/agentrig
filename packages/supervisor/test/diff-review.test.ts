import { describe, expect, it } from "vitest";
import { TrajectoryReviewer, diffLocations, validateDiffReview } from "@agentkitai/agentrig-supervisor";
import type { ModelProvider, ModelRequest, AuxiliaryReport } from "@agentkitai/agentrig-core";

const patch = "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-return 1;\n+return 2;\n";
const answer = { summary: "The constant changed.", findings: [{ path: "a.ts", side: "new", line: 1, severity: "medium", message: "This returns the wrong value." }] };
function provider(text: string) {
  const calls: ModelRequest[] = [];
  const model: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 32_768 },
    async *stream(request) { calls.push(request); yield { type: "text_delta", text }; yield { type: "usage", usage: { input: 20, output: 10 } }; yield { type: "stop", reason: "end_turn" }; } };
  return { model, calls };
}
describe("bounded reviewer diff mode", () => {
  it("uses the existing reviewer with one tool-free accounted call and validates hunk locations", async () => {
    const fake = provider(JSON.stringify(answer)); let usage: AuxiliaryReport | undefined;
    const result = await new TrajectoryReviewer({ provider: fake.model, onUsage: value => { usage = value; } }).reviewDiff({ patch, identity: "fixture" });
    expect(result).toEqual(answer); expect(fake.calls).toHaveLength(1); expect(fake.calls[0]?.tools).toEqual([]);
    expect(fake.calls[0]?.maxTokens).toBe(2048); expect(fake.calls[0]?.system).toContain("untrusted");
    expect(usage?.calls[0]?.usageComplete).toBe(true); expect(usage?.calls[0]?.outcome).toBe("completed");
    expect(diffLocations(patch)).toEqual([{ path: "a.ts", side: "old", line: 1 }, { path: "a.ts", side: "new", line: 1 }]);
  });
  it("never calls a model for empty or oversized/unsupported/incomplete input", async () => {
    const fake = provider(JSON.stringify(answer)); const reviewer = new TrajectoryReviewer({ provider: fake.model });
    expect((await reviewer.reviewDiff({ patch: "", identity: "fixture" })).findings).toEqual([]);
    for (const bad of ["x".repeat(16_385), patch.replace("100644", "160000"), patch.replace("+return 2;\n", ""), patch.replace("+++ b/a.ts", "+++ b/../a.ts"), "diff --git a/a b/a\nold mode 100644\nnew mode 100755\n", "diff --git a/a b/a\nBinary files a/a and b/a differ\n"])
      await expect(reviewer.reviewDiff({ patch: bad, identity: "fixture" })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
  it("refuses prose, invented locations, extra fields and excess findings instead of a clean verdict", async () => {
    for (const value of ["not JSON", JSON.stringify({ ...answer, findings: [{ ...answer.findings[0], line: 9 }] }),
      JSON.stringify({ ...answer, findings: [{ ...answer.findings[0], path: "elsewhere.ts" }] }), JSON.stringify({ ...answer, approved: true }),
      JSON.stringify({ ...answer, findings: Array(17).fill(answer.findings[0]) })]) {
      const fake = provider(value);
      await expect(new TrajectoryReviewer({ provider: fake.model }).reviewDiff({ patch, identity: "fixture" })).rejects.toThrow();
      expect(fake.calls).toHaveLength(1);
    }
    expect(() => validateDiffReview(answer, [])).toThrow("outside captured");
  });
  it("uses smaller response/time bounds and closes an uncooperative provider with unknown usage", async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let usage: AuxiliaryReport | undefined;
    const fake = provider("{}"); fake.model.stream = async function* () { entered(); await new Promise(() => {}); };
    const running = new TrajectoryReviewer({ provider: fake.model, onUsage: report => { usage = report; } })
      .reviewDiff({ patch, identity: "fixture" }, { limits: { callTimeoutMs: 30, timeoutMs: 100 } });
    const refused = expect(running).rejects.toThrow("timed out"); await started; await refused;
    expect(usage?.calls[0]?.usageComplete).toBe(false); expect(usage?.calls[0]?.outcome).toBe("timeout");
    const bounded = provider(JSON.stringify(answer));
    await new TrajectoryReviewer({ provider: bounded.model, maxTokens: 16 }).reviewDiff({ patch, identity: "fixture" });
    expect(bounded.calls[0]?.maxTokens).toBe(16);
  });
});
