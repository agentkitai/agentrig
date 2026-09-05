import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@agentkitai/agentrig-core";
import { FileMemoryStore, LoreBackend } from "@agentkitai/agentrig-memory";
import { memoryLs, memoryPromote, memoryShow } from "../src/memory.ts";
import { buildProgram } from "../src/program.ts";

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
});
