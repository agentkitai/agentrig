import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseSkill, SessionStore, type HarnessEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { runDream, type FullDreamResult } from "@agentkitai/agentrig-memory";
import { buildProgram } from "../src/program.ts";
import { buildAgent } from "../src/agent-builder.ts";
import { renderEvent } from "../src/render.ts";
import { skillFixture, skillProvider } from "../../memory/test/fixtures/skill-emission.ts";

let selectedProvider: ModelProvider;
vi.mock("../src/provider.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/provider.ts")>();
  return { ...actual, buildProviders: vi.fn(() => ({ main: selectedProvider, memory: selectedProvider,
    supervisor: selectedProvider, subagents: selectedProvider, names: ["fixture"],
    roleNames: { main: "fixture", memory: "fixture", supervisor: "fixture", subagents: "fixture" }, get: () => selectedProvider })) };
});

it("manual hint reaches the assembled prompt without claiming activation or replacing custom system instructions", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-manual-guidance-")));
  try {
    const skills = join(root, "skills"); await mkdir(skills);
    await writeFile(join(skills, "manual.md"), "---\nname: manual\ntrigger: When inspecting fixtures\n---\nRead the fixture carefully.");
    for (const custom of [false, true]) {
      const systems: string[] = [];
      selectedProvider = { id: "fixture", model: "prompt", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
        async *stream(request) {
          systems.push(request.system);
          yield { type: "text_delta", text: "No load requested" }; yield { type: "stop", reason: "end_turn" };
        } };
      await buildProgram({ config: { cwd: root, home: root, env: {} }, run: async (_task, opts) => {
        const built = await buildAgent(opts);
        const session = built.agent.run("Inspect", { cwd: root }); const events: HarnessEvent[] = [];
        for await (const event of session.events) events.push(event); await session.done;
        expect(events.some(event => event.type === "skill.used")).toBe(false);
      } }).parseAsync(["run", "fixture", "--skills", skills, "--no-skill-discovery", "--no-repo-map",
        "--root", join(root, `logs-${custom}`), ...(custom ? ["--system", "Custom system instructions"] : [])], { from: "user" });
      expect(systems).toHaveLength(1);
      expect(systems[0]).toContain('[trigger: When inspecting fixtures]');
      expect(systems[0]).toContain('skill({"name":"manual"})');
      expect(systems[0]!.includes("stop at the first matching case")).toBe(!custom);
      if (custom) expect(systems[0]).toContain("Custom system instructions");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("R6b emitted skill reaches actual CLI-built runtime only with chosen opt-in; denied loads never become usage evidence", async () => {
  const f = await skillFixture();
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrig-generated-home-")));
  const dreams: FullDreamResult[] = [];
  try {
    await mkdir(join(home, ".agentrig"));
    await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [f.root]: true } }));
    const preview = await runDream({ ...f, emitSkills: { root: f.skills }, structuralOnly: true }); dreams.push(preview);
    const applied = await runDream({ ...f, emitSkills: { root: f.skills, apply: preview.skillEmission!.digest },
      provider: skillProvider(), limits: { maxCalls: 3 } }); dreams.push(applied);
    expect(applied.skillEmission!.status).toBe("applied");
    const name = applied.skillEmission!.proposals[0]!.name;
    const path = join(f.skills, name, "SKILL.md");
    const emitted = await readFile(path, "utf8");
    expect(parseSkill(emitted, path)).not.toHaveProperty("trigger");
    const hinted = emitted.replace("metadata:\n", 'metadata:\n  agentrig-trigger: "When reviewing a release\\ncheck tests"\n');
    expect(parseSkill(hinted, path).trigger).toBe("When reviewing a release check tests");
    for (const bad of ['true', '["release"]', '""', JSON.stringify("a".repeat(1025))]) {
      expect(() => parseSkill(emitted.replace("metadata:\n", `metadata:\n  agentrig-trigger: ${bad}\n`), path)).toThrow();
    }
    expect(() => parseSkill(hinted.replace("metadata:\n", 'trigger: "ambiguous"\nmetadata:\n'), path)).toThrow(/one placement/);
    await writeFile(path, hinted);
    // A hand-added hint is an edit: regeneration must preserve it, never re-certify it.
    const again = await runDream({ ...f, emitSkills: { root: f.skills }, structuralOnly: true }); dreams.push(again);
    const reapply = await runDream({ ...f, emitSkills: { root: f.skills, apply: again.skillEmission!.digest },
      provider: skillProvider(), limits: { maxCalls: 3 } }); dreams.push(reapply);
    expect(reapply.skillEmission!.status).toBe("refused");
    expect(reapply.skillEmission!.preserved).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(hinted);
    for (const mode of ["default", "enabled", "disabled", "denied", "unapproved", "explicit"] as const) {
      let turn = 0;
      const systems: string[] = [];
      selectedProvider = { id: "fixture", model: "selection", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
        async *stream(request) {
          systems.push(request.system);
          if (turn++ === 0) {
            yield { type: "tool_use", id: "select", name: "skill", input: { name, generated: true } };
            yield { type: "stop", reason: "tool_use" };
          } else { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; }
        } };
      const events: HarnessEvent[] = []; let loaded = false; let sessionId = "";
      const root = join(f.root, `selection-${mode}`);
      await buildProgram({ config: { cwd: f.root, home, env: {} }, run: async (_task, opts) => {
        const built = await buildAgent(opts);
        loaded = built.skills.some(skill => skill.name === name && skill.generated === true);
        const session = built.agent.run("load the selected procedure", { cwd: f.root }); sessionId = session.id;
        for await (const event of session.events) events.push(event); await session.done;
      } }).parseAsync(["run", "fixture", "--memory", f.root, "--root", root, "--no-repo-map", "--max-turns", "3",
        ...(mode === "unapproved" ? [] : ["--allow", "skill"]),
        ...(mode === "default" || mode === "explicit" ? [] : ["--generated-skills"]),
        ...(mode === "disabled" ? ["--no-generated-skills"] : []),
        ...(mode === "denied" ? ["--deny", "skill"] : []),
        ...(mode === "explicit" ? ["--skills", f.skills, "--no-skill-discovery"] : []),
      ], { from: "user" });
      expect(loaded).toBe(!["default", "disabled"].includes(mode));
      expect(systems.length).toBeGreaterThan(0);
      for (const system of systems) {
        expect(system).toContain("stop at the first matching case for the next action");
        expect(system).toContain("Never skip required checks");
        expect(system).toContain("within configured budgets");
        if (!["default", "disabled"].includes(mode)) {
          expect(system).toContain('[trigger: When reviewing a release check tests]');
          expect(system).toContain(`skill(${JSON.stringify({ name })})`);
        } else expect(system).not.toContain("First call for a covered task");
      }
      const used = events.filter(event => event.type === "skill.used");
      if (mode === "enabled" || mode === "explicit") {
        expect(used).toHaveLength(1); expect(used[0]).toMatchObject({ name, generated: true, invokedBy: "model" });
        expect(renderEvent(used[0]!)).toContain("generated=true");
      } else expect(used).toEqual([]);
      if (mode === "denied" || mode === "unapproved") expect(events.some(event => event.type === "tool.denied")).toBe(true);
      expect((await new SessionStore({ root }).readAll(sessionId)).filter(event => event.type === "skill.used")).toEqual(used);
    }
  } finally {
    for (const result of dreams) await result.workspace.dispose();
    await rm(f.root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
  }
});
