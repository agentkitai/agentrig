import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "@agentkitai/agentrig-core";
import { reportEvidence } from "@agentkitai/agentrig-supervisor";
import { showSessionEvidence } from "../src/sessions.js";
import { buildProgram } from "../src/program.js";
import * as config from "../src/config.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(finished = true) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-evidence-cli-")); roots.push(root);
  const store = new SessionStore({ root });
  await store.append("s", { type: "session.start", task: "private task not in evidence", cwd: root, provider: "fixture", model: "fixture" });
  await store.append("s", { type: "plan.updated", items: [{ id: "test", text: "test change", status: "done", accept: "node check.cjs exits 0" }] });
  const call = await store.append("s", { type: "tool.call", id: "x", name: "bash", input: { command: "node check.cjs" }, inputHash: "hash" });
  await store.append("s", { type: "tool.result", id: "x", ok: false, display: "private raw output token", durationMs: 1, toolCallSeq: call.seq,
    commandOutcome: { command: "node check.cjs", cwd: root, exitCode: 1, timedOut: false, aborted: false } });
  if (finished) await store.append("s", { type: "session.end", reason: "done" });
  return { root, store };
}
it("actual sessions show --evidence shares the fold, is read-only, and needs no provider or config", async () => {
  const { root, store } = await fixture();
  await mkdir(join(root, ".agentrig")); await writeFile(join(root, ".agentrig", "config.json"), "malformed secret config must not be read");
  const original = await readFile(store.pathFor("s"), "utf8");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  const configuration = vi.spyOn(config, "loadRunConfig").mockImplementation(() => { throw new Error("config access forbidden"); });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await buildProgram().parseAsync(["sessions", "show", "--evidence", "s", "--root", root], { from: "user" });
  expect(output).toHaveBeenCalledWith(reportEvidence(await store.readAll("s")).text);
  const text = String(output.mock.calls[0]![0]);
  expect(text).toContain("latest exit mismatch"); expect(text).toContain("call#2 → result#3");
  expect(text).toContain("supplied physical-session history; fork ancestors are not assessed");
  expect(text).not.toContain("private raw output"); expect(text).not.toContain("private task");
  expect(network).not.toHaveBeenCalled(); expect(configuration).not.toHaveBeenCalled();
  expect(await readFile(store.pathFor("s"), "utf8")).toBe(original);
});
it("unfinished, corrupt and conflicting views refuse instead of reporting completion", async () => {
  const { store, root } = await fixture(false);
  await expect(showSessionEvidence(store, "s")).rejects.toThrow(/finished/);
  await expect(buildProgram().parseAsync(["sessions", "show", "s", "--evidence", "--json", "--root", root], { from: "user" })).rejects.toThrow(/mutually exclusive/);
  await writeFile(store.pathFor("s"), "{broken}");
  await expect(showSessionEvidence(store, "s")).rejects.toThrow();
});
