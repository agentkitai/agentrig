import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { SpendLedger, SessionStore, trainStatus, trainUsage } from "@agentkitai/agentrig-core";
import { usageCommand } from "../src/usage.ts";
it("queue status and usage --row read two rows and nested spawn logs without mutating sources", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "train-usage-")));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await mkdir(join(root, "queue")); await mkdir(join(root, "logs"));
    const store = new SessionStore({ root: join(root, "logs", "sessions") });
    for (const [id, session] of [["one", "parent"], ["two", "second"]]) {
      await writeFile(join(root, "queue", `${id}.json`), JSON.stringify({ task: "fixture", authorization: "fixture", scope: ["src"], environment: { checkout: root, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } }));
      await writeFile(join(root, "logs", `${id}.state.json`), JSON.stringify({ row: `${id}.json`, phase: "ship", reason: null, pr: null, head: null, mergeCommit: null, sessionIds: [session] }));
    }
    await store.append("parent", { type: "subagent.spawn", id: "child", task: "child" });
    await store.append("child", { type: "subagent.spawn", id: "nested", task: "nested" });
    await store.append("nested", { type: "session.end", reason: "done" });
    await store.append("second", { type: "session.end", reason: "done" });
    const ledger = new SpendLedger(root);
    for (const session of ["parent", "child", "nested", "second"]) {
      const admission = await ledger.admit({ session, segment: session, provider: "openai-chatgpt", model: "chat", reserve: null, rates: null });
      await ledger.settle(admission, { input: 2, output: 3 }, true);
    }
    const before = await readFile(join(root, ".agentrig", "usage.jsonl"), "utf8");
    expect((await trainUsage(root)).map(row => row.totals.input)).toEqual([6, 2]);
    expect((await trainStatus(root)).usage?.[0]?.totals).toMatchObject({ input: 6, output: 9, estimatedMicros: null, unpricedCalls: 3 });
    await usageCommand(root, "2000-01-01", false, { row: "one" });
    expect(log.mock.calls.at(-1)?.[0]).toContain("nested openai-chatgpt/chat: 2 input / 3 output");
    expect(log.mock.calls.at(-1)?.[0]).toContain("ChatGPT-login calls remain unpriced");
    expect(log.mock.calls.at(-1)?.[0]).not.toContain("$0");
    await usageCommand(root, "2000-01-01", true, { row: "two" });
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string)).toMatchObject({ row: "two", totals: { input: 2, output: 3 } });
    expect(await readFile(join(root, ".agentrig", "usage.jsonl"), "utf8")).toBe(before);
  } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
