import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import { EvaluationBudget } from "../src/evaluation-budget.js";
import { evaluationTransport, type EvaluationTransport } from "../src/evaluation-transport.js";

const { R17fBudget } = await import(new URL("../../../eval/r17f-budget.mjs", import.meta.url).href) as {
  R17fBudget: new (tokens: number, minutes: number, output: string) => EvaluationBudget & {
    headroom: number; writes: Promise<void>; record(event: unknown): Promise<void>;
  };
};
const { captureEvidence } = await import(new URL("../../../eval/r17f-evidence.mjs", import.meta.url).href) as {
  captureEvidence: (...args: unknown[]) => Promise<{ captured: string[]; skipped: unknown[]; complete: boolean }>;
};
const { summarizeR17f } = await import(new URL("../../../eval/r17f-summary.mjs", import.meta.url).href) as {
  summarizeR17f: (results: unknown, checks?: unknown) => {
    balancedCount: number; partialRerun: boolean; partialObservations: unknown[];
    comparisons: Array<{ factor: string; otherOn: boolean; additionalPasses: number; numericalThresholdMet: boolean }>;
  };
};
const { schedule } = await import(new URL("../../../eval/live-support.mjs", import.meta.url).href) as {
  schedule: () => Array<{ task: string; repeat: number; supervisor: boolean; memory: boolean }>;
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "agentrig-r17f-observability-")); roots.push(root); return root; }
const request = { system: "PRIVATE REQUEST TEXT", messages: [], tools: [], maxTokens: 10 };
const provider: ModelProvider = { id: "fixture", model: "fixture",
  capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 1000 },
  async *stream() { yield { type: "usage", usage: { input: 90, output: 5 } }; yield { type: "stop", reason: "end_turn" }; } };
async function drain(p: ModelProvider) { for await (const _event of p.stream(request, new AbortController().signal)) { /* consume */ } }

it("journals call start and settled usage without request text, and refuses near-cap admission", async () => {
  const root = await temp(), ledger = new R17fBudget(100, 1, root);
  try {
    await drain(ledger.provider(provider, "main"));
    expect(ledger.tokens).toBe(95);
    await expect(drain(ledger.provider(provider, "supervisor"))).rejects.toThrow(/headroom/);
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.unknownCalls).toBe(0);
    const text = await readFile(join(root, "progress.jsonl"), "utf8");
    expect(text).not.toContain(request.system);
    const rows = text.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.phase)).toEqual(["call-start", "call-settled", "admission-refused"]);
    expect(rows[1]).toMatchObject({ id: rows[0].id, tokens: 95, call: { complete: true, usage: { input: 90, output: 5 } } });
    expect(() => ledger.guard()).toThrow(/headroom/);
  } finally { await ledger.writes; ledger.close(); }
});

it("retains a failed call as unknown and stops further scheduling", async () => {
  const root = await temp(), ledger = new R17fBudget(100, 1, root);
  const failure: ModelProvider = { ...provider, async *stream() { yield { type: "text_delta", text: "partial" }; throw new Error("provider failed"); } };
  try {
    await expect(drain(ledger.provider(failure, "main"))).rejects.toThrow("provider failed");
    expect(ledger.unknownCalls).toBe(1);
    expect(() => ledger.guard()).toThrow(/incomplete/);
    const rows = (await readFile(join(root, "progress.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows[1]).toMatchObject({ phase: "call-settled", unknownCalls: 1, call: { complete: false, usage: null } });
  } finally { await ledger.writes; ledger.close(); }
});

it("stops scheduling after a journal failure but does not poison finalization or later receipts", async () => {
  const root = await temp(), ledger = new R17fBudget(100, 1, root);
  try {
    await mkdir(join(root, "progress.jsonl"));
    await expect(ledger.record({ phase: "failed-write" })).rejects.toThrow();
    await rmdir(join(root, "progress.jsonl"));
    await ledger.record({ phase: "recovery-receipt" });
    await ledger.writes;
    expect(() => ledger.guard()).toThrow(/journal/);
    expect(await readFile(join(root, "progress.jsonl"), "utf8")).toContain("recovery-receipt");
  } finally { await ledger.writes.catch(() => {}); ledger.close(); }
});

it("captures submitted bytes and diff, refuses symlink parents, and records omissions", async () => {
  const root = await temp(), workspace = join(root, "workspace"), directory = join(root, "evidence");
  await mkdir(workspace); await mkdir(directory);
  await writeFile(join(workspace, "answer.md"), "answer evidence\n");
  await writeFile(join(root, "outside.md"), "must not publish");
  await symlink(root, join(workspace, "escape"), "dir");
  await writeFile(join(workspace, "oversized"), "x".repeat(256001));
  const base = evaluationTransport();
  const transport: EvaluationTransport = { ...base, async worker(_worker, args, signal, timeout) {
    if (args[0] === "git") return { code: 0, infrastructure: false, stderr: "", error: null,
      stdout: args[1] === "diff" ? "actual fixture diff" : "answer.md\0escape/outside.md\0oversized\0" };
    return base.command(process.execPath, args.slice(1), { cwd: workspace, signal, timeout });
  } };
  const result = await captureEvidence(transport, { image: "fixture", workspace }, { baseline: "fixture" }, { allowed: ["answer.md"] }, directory);
  expect(result.captured).toEqual(["answer.md"]);
  expect(result.complete).toBe(false);
  expect(result.skipped).toHaveLength(2);
  expect(await readFile(join(directory, "artifacts", "answer.md"), "utf8")).toBe("answer evidence\n");
  await expect(readFile(join(directory, "artifacts", "escape", "outside.md"))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(directory, "diff.json"), "utf8"))).toMatchObject({ stdout: "actual fixture diff" });
});

it("compares only complete balanced blocks, retaining partial failures and pending gates", () => {
  const completed = schedule().slice(0, 35).map((row, index) => ({ ...row,
    key: `${String(index + 1).padStart(3, "0")}-${row.task}-s${+row.supervisor}m${+row.memory}-r${row.repeat}`,
    outcome: row.memory ? "PASS" : "FAIL", reportedTokens: 100, wallMs: 100 }));
  const results = { planned: 96, ledger: { startedAt: 1, tokens: 3500, unknownCalls: 0, blocked: "budget" }, completed };
  const checks = Object.fromEntries(completed.map(row => [row.key, { regression: "PASS", scope: "PASS" }]));
  const summary = summarizeR17f(results, checks);
  expect(summary.balancedCount).toBe(32);
  expect(summary.partialRerun).toBe(true);
  expect(summary.partialObservations).toHaveLength(3);
  expect(summary.comparisons.find(row => row.factor === "memory" && !row.otherOn))
    .toMatchObject({ additionalPasses: 6, numericalThresholdMet: true });
  completed.find(row => row.memory && !row.supervisor)!.outcome = "BLOCKED";
  expect(summarizeR17f(results, checks).comparisons.find(row => row.factor === "memory" && !row.otherOn)?.numericalThresholdMet).toBe(false);
  completed.splice(5, 1); // a gap before the first block cannot be disguised as a balanced subset
  expect(summarizeR17f(results, checks).balancedCount).toBe(0);
  expect(summarizeR17f(results, checks).partialObservations).toHaveLength(34);
});

it("can detect an automatic-task win without inventing pending prose judgments", () => {
  const completed = schedule().map((row, index) => ({ ...row,
    key: `${String(index + 1).padStart(3, "0")}-${row.task}-s${+row.supervisor}m${+row.memory}-r${row.repeat}`,
    outcome: ["A4", "X4"].includes(row.task) ? "BLOCKED" : row.supervisor ? "PASS" : "FAIL",
    reportedTokens: 100, wallMs: 100 }));
  const checks = Object.fromEntries(completed.map(row => [row.key, { regression: "PASS", scope: "PASS" }]));
  const results = { planned: 96, ledger: { startedAt: 1, tokens: 9600, unknownCalls: 0, blocked: null }, completed };
  expect(summarizeR17f(results, checks).comparisons.find(row => row.factor === "supervisor" && !row.otherOn))
    .toMatchObject({ additionalPasses: 18, numericalThresholdMet: true });
  // Automatically verified scope failures on a prose task still veto a win.
  const failed = completed.find(row => row.task === "X4" && row.supervisor && !row.memory)!;
  checks[failed.key]!.scope = "FAIL";
  expect(summarizeR17f(results, checks).comparisons.find(row => row.factor === "supervisor" && !row.otherOn)?.numericalThresholdMet).toBe(false);
});
