import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
import { validateEvaluationProfile } from "../src/evaluation-fixtures.js";
import { resolveProjectChecks } from "../src/project-checks.js";
import { resolveTrainTestTimeout } from "../src/train.js";

const parse = (checks: unknown) => parseConfigText("fixture", JSON.stringify({ checks }));
describe("declared project checks", () => {
  it.each([
    ["python -m pip install -e .", "python -m pytest", "pytest"],
    ["cargo fetch", "cargo test", "cargo-test"],
    ["go mod download", "go test ./...", "go-test"],
  ])("accepts non-JS projects: %s", (bootstrap, command, countsParser) => {
    expect(parse({ bootstrap, steps: [{ name: "test", command, countsParser }] }).checks?.steps[0]?.command).toBe(command);
  });
  it("validates commands, parser names, strict keys and unique names", () => {
    for (const checks of [
      { bootstrap: " ", steps: [] }, { bootstrap: "setup" },
      { bootstrap: "setup", steps: [{ name: "test", command: " " }] },
      { bootstrap: "setup", steps: [{ name: "test", command: "test", countsParser: "unknown" }] },
      { bootstrap: "setup", steps: [], surprise: true },
      { bootstrap: "setup", steps: [{ name: "same", command: "one" }, { name: "same", command: "two" }] },
    ]) expect(() => parse(checks)).toThrow();
  });
  it("replaces the whole checks declaration in a project profile", () => {
    const project = parseConfigText("fixture", JSON.stringify({ checks: { bootstrap: "base", steps: [{ name: "base", command: "base" }] }, profiles: { docs: { checks: { bootstrap: "unused", steps: [] } } } }));
    expect(resolveConfig({ defaults: {}, project, profile: "docs" })).not.toHaveProperty("checks");
    expect(() => validateEvaluationProfile(resolveConfig({ defaults: {}, project, profile: "docs" }))).not.toThrow();
    expect(() => validateEvaluationProfile(resolveConfig({ defaults: {}, project }))).not.toThrow();
  });
  it("resolves and executes a tiny external project in a TEST, not a workflow runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "declared-checks-"));
    const config = join(root, ".agentrig", "config.json");
    try {
      expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root }).status).not.toBe(0);
      await mkdir(join(root, ".agentrig"));
      expect(await resolveProjectChecks(root)).toBeUndefined();
      expect(await resolveProjectChecks(root, "missing")).toBeUndefined();
      await writeFile(config, "{}");
      expect(await resolveProjectChecks(root)).toBeUndefined();
      await expect(resolveProjectChecks(root, "missing")).rejects.toThrow("unknown config profile");
      await writeFile(join(root, "check.cjs"), 'require("node:fs").appendFileSync("order", process.argv[2]+"\\n"); process.exit(Number(process.argv[3] || 0));');
      const command = (name: string) => `"${process.execPath}" check.cjs ${name}`;
      await writeFile(config, JSON.stringify({ checks: { bootstrap: command("bootstrap"), preflight: command("preflight"), steps: [{ name: "first", command: command("first") }, { name: "second", command: command("second") }] }, profiles: { none: { checks: { bootstrap: "MUST_NOT_RUN", preflight: "MUST_NOT_RUN", steps: [] } } } }));
      expect((await resolveProjectChecks(root))?.steps.map(step => step.name)).toEqual(["first", "second"]);
      await expect(readFile(join(root, "order"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await resolveProjectChecks(root, "none")).toEqual({ bootstrap: "MUST_NOT_RUN", preflight: "MUST_NOT_RUN", steps: [] });
      const execute = async (profile?: string) => {
        const checks = await resolveProjectChecks(root, profile);
        if (!checks) throw new Error("missing declaration");
        if (!checks.steps.length) return "declared checks: none";
        const receipts = [];
        for (const step of [{ name: "bootstrap", command: checks.bootstrap }, ...(checks.preflight ? [{ name: "preflight", command: checks.preflight }] : []), ...checks.steps]) {
          const start = new Date().toISOString();
          const result = spawnSync(step.command, { cwd: root, shell: true, encoding: "utf8" });
          receipts.push({ ...step, exit: result.status, start, end: new Date().toISOString(), counts: "N/A" });
          expect(result.status).toBe(0);
        }
        return receipts;
      };
      expect(await execute()).toMatchObject([{ name: "bootstrap", exit: 0 }, { name: "preflight", exit: 0 }, { name: "first", exit: 0 }, { name: "second", exit: 0 }]);
      expect(await readFile(join(root, "order"), "utf8")).toBe("bootstrap\npreflight\nfirst\nsecond\n");
      expect(await execute("none")).toBe("declared checks: none");
      expect(await readFile(join(root, "order"), "utf8")).toBe("bootstrap\npreflight\nfirst\nsecond\n");
      await expect(resolveProjectChecks(root, "missing")).rejects.toThrow("unknown config profile");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Independent cases: one rejection cannot mask a later missing validator.
const validStep = { name: "unit", command: "run" };
it.each([
  ["blank name", { bootstrap: "setup", steps: [{ ...validStep, name: " " }] }],
  ["strict step", { bootstrap: "setup", steps: [{ ...validStep, counts: "vitest" }] }],
  ["strict checks", { bootstrap: "setup", steps: [], extra: true }],
  ["duplicate", { bootstrap: "setup", steps: [validStep, validStep] }],
  ...["bootstrap", "preflight", " bootstrap ", " preflight "].map(name => [name, { bootstrap: "setup", steps: [{ ...validStep, name }] }]),
  ["step limit", { bootstrap: "setup", steps: Array.from({ length: 65 }, (_, i) => ({ ...validStep, name: `n${i}` })) }],
  ["name limit", { bootstrap: "setup", steps: [{ ...validStep, name: "x".repeat(257) }] }],
  ...["bootstrap", "preflight", "command"].flatMap(field => ["x".repeat(4097), "a\nb", "a\tb", "a\rb", "a\0b", "a\x1bb", "a\x7fb", "a\u0085b", "a\u202eb", "a\u2066b", "a\u2028b", "a\u2029b", "\nsetup"].map(value =>
    [`${field}:${JSON.stringify(value).slice(0, 25)}`, { bootstrap: "setup", ...(field === "command" ? {} : { [field]: value }), steps: [{ ...validStep, ...(field === "command" ? { command: value } : {}) }] }])),
  ...["a\nb", "a\x1bb", "a\u202eb"].map(name => ["name control", { bootstrap: "setup", steps: [{ ...validStep, name }] }]),
])("rejects %s independently", (_name, checks) => { expect(() => parse(checks)).toThrow(); });
it("accepts bounded shell syntax without interpreting it", () => {
  const command = `FOO='a|b' tool --flag "$FOO" && echo ok; cat < in > out || echo fail`;
  expect(parse({ bootstrap: "x".repeat(4096), preflight: command,
    steps: Array.from({ length: 64 }, (_, i) => ({ name: `${i}`.padEnd(256, "x"), command, countsParser: "vitest" })) }).checks?.steps).toHaveLength(64);
});
it("forwards a declared Vitest budget to the conductor command, preserving omission", async () => {
  const root = await mkdtemp(join(tmpdir(), "check-budget-"));
  try {
    await mkdir(join(root, ".agentrig"));
    for (const testTimeout of [undefined, 15000]) {
      await writeFile(join(root, ".agentrig/config.json"), JSON.stringify({ checks: { bootstrap: "setup", steps: [{ name: "test", command: "pnpm test", countsParser: "vitest", testTimeout }] } }));
      expect((await resolveProjectChecks(root))?.steps[0]).toEqual({ name: "test", command: testTimeout === undefined ? "pnpm test" : "pnpm test --testTimeout=15000", countsParser: "vitest", ...(testTimeout === undefined ? {} : { testTimeout }) });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each([0, -1, 1.5, 120001, "15000", null])("rejects invalid testTimeout %s", testTimeout => {
  expect(() => parse({ bootstrap: "setup", steps: [{ name: "test", command: "pnpm test", countsParser: "vitest", testTimeout }] })).toThrow();
});
it.each(["echo hi && pnpm test", "pnpm test --testTimeout=1", "python -m pytest"])("rejects ambiguous budget target %s", command => {
  expect(() => parse({ bootstrap: "setup", steps: [{ name: "test", command, countsParser: "vitest", testTimeout: 15000 }] })).toThrow();
});

it("train resolves the same profile budget and omission as conductor", async () => {
  const root = await mkdtemp(join(tmpdir(), "train-budget-"));
  try {
    await mkdir(join(root, ".agentrig"));
    expect(await resolveTrainTestTimeout(root)).toBeUndefined();
    const step = (testTimeout: number) => ({ name: "test", command: "pnpm test", countsParser: "vitest", testTimeout });
    await writeFile(join(root, ".agentrig/config.json"), JSON.stringify({ checks: { bootstrap: "setup", steps: [step(15000)] }, profiles: { ci: { checks: { bootstrap: "setup", steps: [step(30000)] } }, none: { checks: { bootstrap: "setup", steps: [] } } } }));
    expect(await resolveTrainTestTimeout(root)).toBe(15000);
    expect(await resolveTrainTestTimeout(root, "ci")).toBe(30000);
    expect(await resolveTrainTestTimeout(root, "none")).toBeUndefined();
    await writeFile(join(root, ".agentrig/config.json"), JSON.stringify({ checks: { bootstrap: "setup", steps: [step(15000), { ...step(30000), name: "second" }] } }));
    await expect(resolveTrainTestTimeout(root)).rejects.toThrow("ambiguous");
  } finally { await rm(root, { recursive: true, force: true }); }
});
