import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionStore } from "@agentkitai/agentrig-core";
import { FileMemoryStore, runDream } from "@agentkitai/agentrig-memory";
import { buildProgram } from "../src/program.ts";

vi.mock("@agentkitai/agentrig-memory", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentkitai/agentrig-memory")>();
  return { ...actual, runDream: vi.fn(actual.runDream) };
});

it("real CLI --skill-candidates reaches the actual structural dream with no credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-procedures-"));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  const lines = ["Scope: Local test workflow", "Step 1: Inspect inputs", "Step 2: Execute tests", "Step 3: Review results", "Limitation: Deployment needs separate approval"];
  try {
    const logs = new SessionStore({ root: join(root, "raw/sessions") });
    for (const id of ["s1", "s2"]) {
      await logs.append(id, { type: "session.start", task: "observe", cwd: root, provider: "fixture", model: "fixture" });
      await logs.append(id, { type: "tool.call", id: "call", name: "bash", input: {}, inputHash: "fixture" });
      await logs.append(id, { type: "tool.result", id: "call", ok: true, display: `${id}\n${lines.join("\n")}`, durationMs: 0 });
      await logs.append(id, { type: "session.end", reason: "done" });
    }
    const wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init();
    await wiki.write("concepts/workflow.md", { body: lines.map(claim => `- [observed] ${claim} (session:s1, session:s2)`).join("\n"),
      frontmatter: { type: "concept", slug: "workflow", aliases: [], confidence: "high", sources: ["session:s1", "session:s2"], updated: "2026-09-06" } });
    await buildProgram().exitOverride().parseAsync(["dream", "--dir", root, "--skill-candidates", "--structural-only"], { from: "user" });
    expect(vi.mocked(runDream).mock.calls[0]?.[0]).toMatchObject({ procedureCandidates: true, structuralOnly: true });
    expect(output.mock.calls.flat().join("\n")).toContain("skill-candidate [structural-unassessed]");
    expect(error.mock.calls.flat().join("\n")).not.toContain("credential");
  } finally {
    for (const call of vi.mocked(runDream).mock.results) if (call.type === "return") await (await call.value).workspace.dispose();
    vi.mocked(runDream).mockClear(); output.mockRestore(); error.mockRestore(); process.exitCode = exitCode;
    await rm(root, { recursive: true, force: true });
  }
});
