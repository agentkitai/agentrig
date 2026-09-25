import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SpendLedger, rollupTrainUsage, type SpendRecord } from "@agentkitai/agentrig-core";
it("joins calls before grouping two rows, nested children, session/model, unpriced tokens and incomplete calls", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "row-usage-")));
  try {
    const ledger = new SpendLedger(root);
    const records: SpendRecord[] = [];
    for (const [session, model, priced] of [["parent", "m", true], ["child", "m", true], ["nested", "chat", false], ["second", "m", true]] as const) {
      const admission = await ledger.admit({ segment: session, session, model, provider: priced ? "openai" : "openai-chatgpt", reserve: priced ? 100 : null,
        rates: priced ? { inputUsdPerMTok: 1, outputUsdPerMTok: 2, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 } : null });
      await ledger.settle(admission, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, true);
    }
    records.push(...await ledger.records());
    const rows = rollupTrainUsage(records, [{ row: "one", sessions: ["parent"] }, { row: "two", sessions: ["second"] }], [{ parent: "child", child: "nested" }, { parent: "parent", child: "child" }]);
    expect(rows.map(row => [row.row, row.totals.input, row.totals.output, row.totals.estimatedMicros, row.totals.unpricedCalls])).toEqual([["one", 30, 60, 100, 1], ["two", 10, 20, 50, 0]]);
    expect(rows[0]!.sessions.find(session => session.session === "nested")!.totals).toMatchObject({ input: 10, output: 20, estimatedMicros: null });
    expect(rows[0]!.sessions.map(session => session.session)).toEqual(["child", "nested", "parent"]);
    expect(rows[0]!.sessions.find(session => session.session === "nested")!.models[0]).toMatchObject({ provider: "openai-chatgpt", model: "chat", input: 10, output: 20, estimatedMicros: null, unpricedCalls: 1 });
    // Replaying identical settlements must not double count; conflicts must fail closed.
    expect(rollupTrainUsage([...records, records[1]!], [{ row: "one", sessions: ["parent"] }], [])[0]!.totals.input).toBe(10);
    const ambiguous = rollupTrainUsage(records, [{ row: "one", sessions: ["parent"] }, { row: "two", sessions: ["parent"] }, { row: "three", sessions: ["second"] }], [{ parent: "child", child: "nested" }, { parent: "parent", child: "child" }]);
    expect(ambiguous.map(row => row.totals.input)).toEqual([0, 0, 10]);
    for (const row of ambiguous.slice(0, 2)) {
      expect(row.sessions).toEqual([]);
      for (const session of ["parent", "child", "nested"]) expect(row.coverageWarnings).toContain(`ambiguous session ${session} claimed by multiple rows (one, two); excluded`);
    }
    expect(ambiguous[2]!.coverageWarnings).toEqual([]);
    const overlap = rollupTrainUsage(records, [{ row: "one", sessions: ["parent"] }, { row: "two", sessions: ["child"] }], [{ parent: "child", child: "nested" }, { parent: "parent", child: "child" }]);
    expect(overlap.map(row => row.totals.input)).toEqual([10, 0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("status reports observed child entry, overrides and unknown legacy routing without inventing row intent", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { SessionStore, trainStatus } = await import("@agentkitai/agentrig-core");
  const root = await realpath(await mkdtemp(join(tmpdir(), "provider-rollup-")));
  try {
    await mkdir(join(root, "done")); await mkdir(join(root, "logs"));
    await writeFile(join(root, "done/one.json"), JSON.stringify({ task: "fixture", authorization: "fixture", scope: ["test"], builderProvider: "sol", environment: { checkout: root, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } }));
    await writeFile(join(root, "logs/one.state.json"), JSON.stringify({ row: "one.json", phase: "done", reason: null, pr: null, head: null, mergeCommit: null, sessionIds: ["parent"] }));
    const store = new SessionStore({ root: join(root, "logs/sessions") });
    for (const child of ["builder", "fixer", "legacy"]) await store.append("parent", { type: "subagent.spawn", id: child, task: "fixture" });
    for (const [session, entry] of [["parent", "default"], ["builder", "sol"], ["fixer", "alternate"]]) {
      await store.append(session!, { type: "context.manifest", turn: 1, requestHash: "fixture", blocks: [], providerSelection: { entry: entry!, provider: "openai", model: "fixture" } });
    }
    await store.append("legacy", { type: "session.end", reason: "done" });
    const status = await trainStatus(root);
    expect(status.usageError).toBeUndefined();
    expect(status.usage?.[0]?.sessions.map(s => [s.session, s.builderProvider])).toEqual([["builder", "sol"], ["fixer", "alternate"], ["legacy", null], ["parent", "default"]]);
    expect(status.usage?.[0]?.totals.calls).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
