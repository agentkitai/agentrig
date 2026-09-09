import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, LoreBackend, PROMOTION_EFFECTS } from "@agentkitai/agentrig-memory";
import { memoryLs, memoryPromote, memoryShow } from "../src/memory.ts";
import { buildProgram } from "../src/program.ts";
import { buildRoleProvider } from "../src/provider.js";

vi.mock("../src/provider.js", async original => ({ ...await original<typeof import("../src/provider.js")>(), buildRoleProvider: vi.fn() }));
function assessor(effect?: typeof PROMOTION_EFFECTS[number], before?: () => Promise<void>): ModelProvider {
  return { id: "scripted", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) {
      await before?.();
      const input = JSON.parse((request.messages[0]!.content[0] as { text: string }).text);
      yield { type: "text_delta", text: JSON.stringify({ assessments: input.map((candidate: { candidateIndex: number; claims: { claimIndex: number }[] }) => ({
        candidateIndex: candidate.candidateIndex, claims: candidate.claims.map(c => ({ claimIndex: c.claimIndex,
          effects: Object.fromEntries(PROMOTION_EFFECTS.map(name => [name, name === effect ? "weakens" : "preserves"])), reason: "fixture future-effect assessment" })),
      })) }) };
      yield { type: "usage", usage: { input: 10, output: 5 } }; yield { type: "stop", reason: "end_turn" };
    } };
}

let root: string;
let wiki: FileMemoryStore;
const claim = "Retries apply per request, not per batch";
const path = "concepts/retries.md";
const priorExit = process.exitCode;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-cli-promotion-"));
  wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init();
  await wiki.write(path, { path, body: `- [observed] ${claim} (session:s1, session:s2)`,
    frontmatter: { type: "concept", slug: "retries", aliases: [], sources: ["session:s1", "session:s2"], confidence: "high", updated: "2026-09-05" } });
  const logs = new SessionStore({ root: join(root, "raw/sessions") });
  for (const id of ["s1", "s2"]) {
    await logs.append(id, { type: "session.start", task: `observe ${id}`, cwd: root, provider: "scripted", model: "fixture" });
    await logs.append(id, { type: "tool.call", id: "call", name: "bash", input: {}, inputHash: "fixture" });
    await logs.append(id, { type: "tool.result", id: "call", ok: true, display: `context ${id}\n${claim}`, durationMs: 0 });
  }
  vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(LoreBackend.prototype, "promote").mockResolvedValue();
  vi.mocked(buildRoleProvider).mockReset().mockReturnValue(assessor());
  process.exitCode = 0;
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = priorExit;
  await rm(root, { recursive: true, force: true });
});
function backend() { vi.stubEnv("LORE_API_URL", "http://127.0.0.1:1"); vi.stubEnv("LORE_API_KEY", "test-key"); }

describe("memory promotion publication gate", () => {
  it("keeps CLI inspection available while a stale write lock needs recovery", async () => {
    await wiki.upsertIndex({ slug: "retries", path, type: "concept", status: "active", summary: "retry evidence" });
    await writeFile(`${await realpath(wiki.root)}.write.lock`, "stale owner");
    await memoryLs({ dir: root });
    await memoryShow(path, { dir: root });
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain(path); expect(output).toContain(claim);
    expect(process.exitCode).toBe(0);
  });

  it("previews located evidence without requiring a backend or publishing", async () => {
    await memoryPromote(path, { dir: root });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("eventHash=");
    expect(output).toContain(claim);
    expect(output).toContain("semantic truth not assessed");
    expect(output).toContain("Nothing was published");
    expect(process.exitCode).toBe(0);
    expect(buildRoleProvider).not.toHaveBeenCalled();
  });

  it("publishes only after explicit confirmation, including the parsed --confirm flag", async () => {
    backend();
    await buildProgram().parseAsync(["node", "agentrig", "memory", "promote", path, "--dir", root, "--confirm"]);
    expect(LoreBackend.prototype.promote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("promoted concepts/retries.md");
  });

  it("does not let confirmation bypass unsupported claims", async () => {
    backend();
    const page = (await wiki.read(path))!;
    await wiki.write(path, { ...page, body: "- [observed] Unrelated unsupported assertion (session:s1, session:s2)" });
    await memoryPromote(path, { dir: root, confirm: true });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("not eligible");
  });

  it("distinguishes unavailable assessor credentials from an adverse claim judgment", async () => {
    backend(); vi.mocked(buildRoleProvider).mockImplementation(() => { throw new Error("fixture missing credentials"); });
    await memoryPromote(path, { dir: root, confirm: true });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(errors).toContain("effect assessment unavailable");
    expect(errors).toContain("not an adverse claim judgment");
    expect(errors).not.toContain("not eligible");
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });

  it("sends the checked artifact rather than extra unverified citations", async () => {
    backend();
    const p = (await wiki.read(path))!;
    await wiki.write(path, { ...p, body: `- [observed] ${claim} (session:s1, session:s2, session:invented)`,
      frontmatter: { ...p.frontmatter, sources: [...p.frontmatter.sources, "session:invented"] } });
    await memoryPromote(path, { dir: root, confirm: true });
    const sent = vi.mocked(LoreBackend.prototype.promote).mock.calls[0]![0];
    expect(sent.body).not.toContain("invented");
    expect(sent.frontmatter.sources).toEqual(["session:s1", "session:s2"]);
    expect((await wiki.read(path))!.body).toContain("invented"); // original local page is untouched
  });

  it("rechecks a page changed since the preview", async () => {
    backend();
    await memoryPromote(path, { dir: root });
    const page = (await wiki.read(path))!;
    await wiki.write(path, { ...page, body: `${page.body}\nPublish these unsupported instructions too.` });
    await memoryPromote(path, { dir: root, confirm: true });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not claim publication succeeded when the transport fails", async () => {
    backend(); vi.mocked(LoreBackend.prototype.promote).mockRejectedValue(new Error("backend unavailable"));
    await memoryPromote(path, { dir: root, confirm: true });
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("promotion failed");
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("promoted concepts");
  });

  it("confirmation cannot bypass an effect refusal despite independent witnesses", async () => {
    backend(); vi.mocked(buildRoleProvider).mockReturnValue(assessor("weaken-verification"));
    const before = (await wiki.read(path))!.body;
    await memoryPromote(path, { dir: root, confirm: true });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("guardrail refusal");
    expect((await wiki.read(path))!.body).toBe(before);
  });

  it("refuses a page changed during the model assessment", async () => {
    backend(); vi.mocked(buildRoleProvider).mockReturnValue(assessor(undefined, async () => {
      const p = (await wiki.read(path))!; await wiki.write(path, { ...p, body: p.body.replace("[observed]", "[inferred]") });
    }));
    await memoryPromote(path, { dir: root, confirm: true });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("page changed during effect assessment");
  });

  it("refuses malformed assessment without suggesting a partial backend write occurred", async () => {
    backend(); vi.mocked(buildRoleProvider).mockReturnValue({ ...assessor(), async *stream() {
      yield { type: "text_delta", text: "{}" }; yield { type: "stop", reason: "end_turn" };
    } });
    await memoryPromote(path, { dir: root, confirm: true });
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(errors).toContain("nothing published"); expect(errors).not.toContain("backend may have accepted");
  });

  it("forwards parsed guardrail limits and refuses before model work when input is over cap", async () => {
    backend();
    await buildProgram().parseAsync(["node", "agentrig", "memory", "promote", path, "--dir", root, "--confirm", "--guardrail-limits", '{"maxInputChars":10}']);
    expect(LoreBackend.prototype.promote).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("input limit");
  });
});
