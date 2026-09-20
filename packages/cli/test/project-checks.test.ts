import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
import { resolveProjectChecks } from "../src/project-checks.js";

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
    expect(resolveConfig({ defaults: {}, project, profile: "docs" }).checks).toEqual({ bootstrap: "unused", steps: [] });
  });
  it("resolves and executes a tiny external project in a TEST, not a workflow runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "declared-checks-"));
    const config = join(root, ".agentrig", "config.json");
    try {
      expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root }).status).not.toBe(0);
      await mkdir(join(root, ".agentrig"));
      expect(await resolveProjectChecks(root)).toBeUndefined();
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

it.each(["dogfood", "topic", "review", "arbiter"])("%s pins operative declared-checks policy", async (skill) => {
  const text = await readFile(resolve(".agentrig/skills", skill, "SKILL.md"), "utf8");
  expect(text).not.toMatch(/pnpm/i);
  const policy = text.split("## Operative declared-checks policy (issue #395)")[1]?.split("\n## ")[0] ?? "";
  for (const required of ["shipping policy §3", "supersedes", "GREEN BEFORE launching", "reviewers do NOT run checks", "name, command, exit code, UTC start/end, counts", "declared checks: none", "exact-head CI plus human merge authorization", "permission", "project-checks.js", "bootstrap and preflight"]) expect(policy).toContain(required);
});
