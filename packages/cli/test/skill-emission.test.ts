import { readFile, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { parseSkillFrontmatter } from "@agentkitai/agentrig-core";
import { runDream } from "@agentkitai/agentrig-memory";
import { buildProgram } from "../src/program.ts";
import { skillFixture, skillProvider } from "../../memory/test/fixtures/skill-emission.ts";

vi.mock("@agentkitai/agentrig-memory", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentkitai/agentrig-memory")>();
  return { ...actual, runDream: vi.fn(actual.runDream) };
});
vi.mock("../src/provider.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/provider.ts")>();
  return { ...actual, buildRoleProvider: vi.fn(() => skillProvider()) };
});

it("actual CLI previews, confirms exact digest, writes parser-compatible skill without applying wiki, and rejects unsafe flags/digests", async () => {
  const f = await skillFixture();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  const args = ["dream", "--dir", f.root, "--emit-skills"];
  try {
    await buildProgram().exitOverride().parseAsync([...args, "--structural-only"], { from: "user" });
    const preview = await vi.mocked(runDream).mock.results[0]!.value;
    expect(preview.skillEmission!.status).toBe("preview"); expect(preview.auxiliary?.calls).toHaveLength(0);
    expect(output.mock.calls.flat().join("\n")).toContain(`--apply ${preview.skillEmission!.digest}`);
    await buildProgram().exitOverride().parseAsync([...args, "--apply", preview.skillEmission!.digest, "--dream-limits", '{"maxCalls":3}'], { from: "user" });
    const applied = await vi.mocked(runDream).mock.results[1]!.value;
    expect(applied.skillEmission!.status).toBe("applied"); expect(applied.autoApply).toBeUndefined();
    expect(applied.auxiliary?.calls).toHaveLength(3);
    const text = await readFile(applied.skillEmission!.written[0]!, "utf8");
    expect(parseSkillFrontmatter(text).fields.metadata!["agentrig-generated"]).toBe("true");
    for (const extra of [["--review"], ["--auto"], ["--structural-only"]]) {
      await buildProgram().exitOverride().parseAsync([...args, "--apply", preview.skillEmission!.digest, ...extra], { from: "user" });
      expect(process.exitCode).toBe(1);
    }
    expect(vi.mocked(runDream)).toHaveBeenCalledTimes(2);
    await buildProgram().exitOverride().parseAsync([...args, "--apply", "0".repeat(64), "--dream-limits", '{"maxCalls":3}'], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect((await vi.mocked(runDream).mock.results[2]!.value).skillEmission!.status).toBe("refused");
    expect(errors.mock.calls.flat().join("\n")).toContain("cannot combine");
  } finally {
    for (const call of vi.mocked(runDream).mock.results) if (call.type === "return") await (await call.value).workspace.dispose();
    vi.mocked(runDream).mockClear(); output.mockRestore(); errors.mockRestore(); process.exitCode = exitCode;
    await rm(f.root, { recursive: true, force: true });
  }
});
