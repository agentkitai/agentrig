import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileMemoryStore, FileRawStore, ingestOnSessionEnd, ingestSession, LoreBackend } from "@agentkitai/agentrig-memory";
import { memoryIngest } from "../src/memory.js";
import { buildProviders, buildRoleProvider } from "../src/provider.js";
import { buildAgent } from "../src/agent-builder.js";

vi.mock("../src/provider.js", async original => ({ ...await original<typeof import("../src/provider.js")>(), buildRoleProvider: vi.fn(), buildProviders: vi.fn() }));
vi.mock("@agentkitai/agentrig-memory", async original => {
  const actual = await original<typeof import("@agentkitai/agentrig-memory")>();
  return { ...actual, ingestSession: vi.fn(actual.ingestSession), ingestOnSessionEnd: vi.fn(actual.ingestOnSessionEnd) };
});
let root: string;
const priorExit = process.exitCode;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-cli-ingest-lifecycle-"));
  await mkdir(join(root, "raw/sessions"), { recursive: true });
  await writeFile(join(root, "raw/sessions/s1.jsonl"), JSON.stringify({ type: "session.start", task: "inspect retry", cwd: root }) + "\n");
  vi.mocked(ingestSession).mockClear();
  vi.mocked(ingestOnSessionEnd).mockClear();
  vi.mocked(buildRoleProvider).mockReturnValue({ id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() { yield { type: "text_delta", text: JSON.stringify({ facts: [{ pageType: "concept", slug: "retry", tag: "observed", text: "Retry each request" }] }) }; },
  });
  const model = buildRoleProvider({});
  vi.mocked(buildProviders).mockReturnValue({ main: model, memory: model, supervisor: model, subagents: model,
    names: ["default"], roleNames: { main: "default", memory: "default", supervisor: "default", subagents: "default" }, get: () => model });
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = priorExit; await rm(root, { recursive: true, force: true }); });

it("ships a raw backend into bounded ingest so an actual backend timeout is not recorded as completed", async () => {
  vi.stubEnv("LORE_API_URL", "http://fixture"); vi.stubEnv("LORE_API_KEY", "fixture");
  vi.spyOn(LoreBackend.prototype, "conflicts").mockResolvedValue([]);
  vi.spyOn(LoreBackend.prototype, "onIngest").mockRejectedValue(new DOMException("remote timed out", "TimeoutError"));
  await memoryIngest("s1", { dir: root });
  const result = await vi.mocked(ingestSession).mock.results[0]!.value;
  expect(result.auxiliary.calls.find((call: { operation: string }) => call.operation === "backend.onIngest"))
    .toMatchObject({ outcome: "timeout", usageComplete: false });
  expect(await readFile(join(root, "wiki/concepts/retry.md"), "utf8")).toContain("Retry each request");
});

it("passes configured bounds without initializing the wiki or scanning all session logs", async () => {
  const init = vi.spyOn(FileMemoryStore.prototype, "init");
  const sessions = vi.spyOn(FileRawStore.prototype, "sessions");
  await expect(memoryIngest("s1", { dir: root, ingestLimits: { maxOutputChars: 2 }, ingestSpanChars: "4000" })).rejects.toThrow("output limit");
  expect(init).not.toHaveBeenCalled(); expect(sessions).not.toHaveBeenCalled();
  expect(vi.mocked(ingestSession).mock.calls[0]![0]).toMatchObject({ limits: { maxOutputChars: 2 }, maxSpanChars: 4000 });
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("auxiliary ingest");
});

it.each(["../evil", "s1.jsonl", "sources/s1"])("reports an invalid session id %s without throwing or starting work", async id => {
  await expect(memoryIngest(id, { dir: root })).resolves.toBeUndefined();
  expect(process.exitCode).toBe(1);
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("use the ID, not a filename or path");
  expect(ingestSession).not.toHaveBeenCalled();
});

it("wires agent-builder limits, span size and backend diagnostics into the scheduled hook", async () => {
  await buildAgent({ root: join(root, "raw/sessions"), memory: root, maxTurns: "1", maxTokensPerTurn: "20",
    ingestOnEnd: true, ingestLimits: { maxSpans: 100, maxCalls: 102 }, ingestSpanChars: "8000", skillDiscovery: false, sandbox: "none" });
  expect(ingestOnSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ limits: { maxSpans: 100, maxCalls: 102 }, maxSpanChars: 8000, onBackendError: expect.any(Function) }));
  vi.mocked(ingestOnSessionEnd).mock.calls[0]![0].onBackendError!("onIngest", new Error("backend offline"));
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("lore onIngest failed (continuing): backend offline");
});
