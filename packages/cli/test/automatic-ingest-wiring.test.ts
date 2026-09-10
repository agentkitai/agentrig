import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildAgent } from "../src/agent-builder.js";

it("ordinary CLI assembly defers a direct answer without dispatching a memory model", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-auto-ingest-wiring-"));
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-only");
  const notices: string[] = []; const settled = vi.fn();
  let session: ReturnType<Awaited<ReturnType<typeof buildAgent>>["agent"]["run"]> | undefined;
  try {
    const built = await buildAgent({ root: join(root, "raw", "sessions"), memory: root, ingestOnEnd: true,
      provider: "anthropic", model: "fixture", maxTurns: "2", maxTokensPerTurn: "128", repoMap: false,
      packages: false, extensionDiscovery: false, skillDiscovery: false },
      { cwd: root, onHookDone: m => notices.push(m), onIngestUsage: settled });
    const main = vi.spyOn(built.provider, "stream").mockImplementation(async function* () {
      yield { type: "text_delta", text: "A direct explanation." };
      yield { type: "stop", reason: "end_turn" };
    });
    const memory = built.providers.memory === built.provider ? main : vi.spyOn(built.providers.memory, "stream").mockImplementation(async function* () {
      throw new Error("read-only answer must not dispatch memory");
    });
    session = built.agent.run("Explain a concept without changing anything", { cwd: root });
    for await (const _event of session.events) { /* consume real assembly */ }
    expect((await session.done).reason).toBe("done");
    expect(main).toHaveBeenCalledTimes(1);
    if (memory !== main) expect(memory).not.toHaveBeenCalled();
    expect(notices.join("\n")).toContain("automatic memory ingest deferred");
    expect(notices.join("\n")).toContain("manual memory ingest");
    expect(settled).toHaveBeenCalledExactlyOnceWith(undefined, true);
    await expect(stat(join(root, "wiki"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    session?.control.abort(); await session?.done.catch(() => undefined);
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
});
