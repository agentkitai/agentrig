import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionStore, type HarnessEvent, type ModelProvider } from "@agentkitai/agentrig-core";
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
    for (const mode of ["default", "enabled", "disabled", "denied", "unapproved", "explicit"] as const) {
      let turn = 0;
      selectedProvider = { id: "fixture", model: "selection", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
        async *stream() {
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
