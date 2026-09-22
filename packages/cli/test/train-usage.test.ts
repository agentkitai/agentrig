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
it("uses live log prefixes and scopes session and ledger warnings to their rows/checkouts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "train-coverage-")));
  try {
    await mkdir(join(root, "queue")); await mkdir(join(root, "logs"));
    const other = join(root, "other"); await mkdir(other);
    const store = new SessionStore({ root: join(root, "logs", "sessions") });
    for (const [id, session, checkout] of [["one", "parent", root], ["two", "second", root], ["three", "parent", other]]) {
      await writeFile(join(root, "queue", `${id}.json`), JSON.stringify({ task: "fixture", authorization: "fixture", scope: ["src"], environment: { checkout, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } }));
      await writeFile(join(root, "logs", `${id}.state.json`), JSON.stringify({ row: `${id}.json`, phase: "ship", reason: null, pr: null, head: null, mergeCommit: null, sessionIds: [session] }));
    }
    await store.append("parent", { type: "subagent.spawn", id: "child", task: "child" });
    await store.append("second", { type: "session.end", reason: "done" });
    const parentLog = join(root, "logs", "sessions", "parent.jsonl");
    const prefix = await readFile(parentLog, "utf8");
    await writeFile(parentLog, prefix + '{"type":');
    const ledger = new SpendLedger(root);
    const admission = await ledger.admit({ session: "child", segment: "s", provider: "openai-chatgpt", model: "chat", reserve: null, rates: null });
    await ledger.settle(admission, { input: 7, output: 3 }, true);
    await ledger.gap("s", "child");
    await ledger.gap("unknown");
    await ledger.admit({ segment: "unknown", provider: "openai-chatgpt", model: "chat", reserve: null, rates: null });
    const foreign = new SpendLedger(other);
    const foreignAdmission = await foreign.admit({ session: "parent", segment: "s", provider: "openai-chatgpt", model: "chat", reserve: null, rates: null });
    await foreign.settle(foreignAdmission, { input: 11, output: 1 }, true);
    const status = await trainStatus(root);
    status.usage?.sort((a, b) => ["one", "two", "three"].indexOf(a.row) - ["one", "two", "three"].indexOf(b.row));
    expect(status.usage?.map(row => row.totals.input)).toEqual([7, 0, 11]);
    const [one, two, three] = status.usage!;
    expect(one!.coverageWarnings).toEqual(expect.arrayContaining([
      "torn spawn log tail: parent; valid prefix used, descendants may be unattributed",
      "missing spawn log: child; descendants may be unattributed",
      "session child: ledger coverage gap; row totals exclude unmetered calls",
    ]));
    expect(two!.coverageWarnings).toHaveLength(2);
    expect(two!.coverageWarnings.every(warning => warning.startsWith(`ledger-wide (${root}):`))).toBe(true);
    expect(three!.coverageWarnings.some(warning => warning.includes("ledger") || warning.includes("ambiguous"))).toBe(false);
    expect(await readFile(parentLog, "utf8")).toBe(prefix + '{"type":');
    // A terminated malformed line is not silently accepted as a live append.
    await writeFile(parentLog, prefix + '{"type":\n');
    const corrupt = (await trainUsage(root)).sort((a, b) => ["one", "two", "three"].indexOf(a.row) - ["one", "two", "three"].indexOf(b.row));
    expect(corrupt[0]!.coverageWarnings).toContain("unreadable spawn log: parent; descendants may be unattributed");
    expect(corrupt[1]!.coverageWarnings).toEqual(two!.coverageWarnings);
    expect(corrupt[0]!.totals.input).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
