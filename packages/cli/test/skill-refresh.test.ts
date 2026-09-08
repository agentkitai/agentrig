import { mkdir, mkdtemp, realpath, rm, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest } from "@agentkitai/agentrig-core";
import type { TuiController } from "../src/tui/controller.js";

/**
 * Issue #267: the skill catalogue was read once, at startup. An edited `SKILL.md` therefore kept
 * serving the body the process had read at launch — in slash completion, in the `/<skill>` turn
 * the TUI composes, in the model's `skill` tool and in the system-prompt listing — for the life
 * of the session. These drive the real startup wiring (`startTui`) rather than a hand-assembled
 * controller, because the defect was that four consumers each held their own copy: a refresh that
 * reached only the one a test wired up would look fixed and still be broken.
 */
const harness = vi.hoisted(() => ({ exercise: undefined as ((controller: TuiController) => Promise<void>) | undefined }));
// Only terminal mounting is replaced; the controller, agent and catalogue are the real ones.
vi.mock("ink", async original => ({ ...await original<typeof import("ink")>(), render: (element: { props: { controller: TuiController } }) => ({
  unmount() {}, waitUntilExit: () => harness.exercise!(element.props.controller),
}) }));
const requests: ModelRequest[] = [];
const done: ModelEvent[] = [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }];
/** Set by a test that wants the model to call the `skill` tool rather than just answer. */
let loadSkill: string | undefined;
const provider: ModelProvider = {
  id: "fixture", model: "none", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
  async *stream(request) {
    requests.push(structuredClone(request));
    const name = loadSkill; loadSkill = undefined;
    if (name === undefined) { yield* done; return; }
    yield { type: "tool_use", id: "load", name: "skill", input: { name } };
    yield { type: "stop", reason: "tool_use" };
  },
};
vi.mock("../src/provider.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/provider.ts")>();
  return { ...actual, buildProviders: () => ({ main: provider, memory: provider, supervisor: provider, subagents: provider,
    names: ["fixture"], roleNames: { main: "fixture", memory: "fixture", supervisor: "fixture", subagents: "fixture" }, get: () => provider }) };
});
import { startTui } from "../src/tui/start.js";

const roots: string[] = [];
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
afterEach(async () => {
  vi.restoreAllMocks(); requests.length = 0; harness.exercise = undefined; loadSkill = undefined;
  if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", tty);
  process.exitCode = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; skills: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-skill-refresh-"))); roots.push(root);
  const skills = join(root, "skills"); await mkdir(skills);
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return { root, skills };
}

/** Runs the real startup, then the caller's script against the controller it mounted. */
async function session(f: { root: string; skills?: string }, exercise: (controller: TuiController) => Promise<void>): Promise<void> {
  harness.exercise = exercise;
  await startTui({ root: join(f.root, "logs"), provider: "fixture", model: "fixture", repoMap: false,
    maxTurns: "5", maxTokensPerTurn: "1000", skillDiscovery: false, packages: false, allow: ["skill"],
    ...(f.skills === undefined ? {} : { skills: [f.skills] }) });
}

const text = (controller: TuiController): string => controller.snapshot().lines.map(line => line.text).join("\n");
/** The catalogue block the model was actually sent, in that request's system prompt. */
const catalogue = (index: number): string => requests[index]!.system;
/**
 * Only the newest message of that request — the turn a `/<skill>` invocation composed, or the
 * result the `skill` tool returned. Asserting over the whole message list would pass on anything
 * an earlier turn of the same conversation had already said.
 */
const newest = (index: number): string => JSON.stringify(requests[index]!.messages.at(-1));

it("a changed body reaches the composed turn, the model's tool and the catalogue together at /new", async () => {
  const f = await fixture();
  await writeFile(join(f.skills, "deploy.md"), "---\ndescription: ship the old way\n---\nOLD BODY", "utf8");
  await session(f, async controller => {
    await controller.submit("/deploy now");
    expect(newest(0)).toContain("OLD BODY");
    expect(catalogue(0)).toContain("deploy: ship the old way");

    await writeFile(join(f.skills, "deploy.md"), "---\ndescription: ship the new way\n---\nNEW BODY", "utf8");
    // the running conversation keeps the generation it started with: no rescan without /new
    await controller.submit("/deploy again");
    expect(newest(1)).toContain("OLD BODY");
    expect(newest(1)).not.toContain("NEW BODY");
    expect(catalogue(1)).toContain("ship the old way");

    await controller.submit("/new");
    expect(text(controller)).toContain("skills reloaded: updated deploy");
    await controller.submit("/skills");
    expect(text(controller)).toContain("/deploy — ship the new way");

    // the model's own lookup, on the first turn of the fresh conversation: nothing in this
    // request's history has ever mentioned either body
    loadSkill = "deploy";
    await controller.submit("let the model choose");
    expect(catalogue(2)).toContain("deploy: ship the new way");
    expect(catalogue(2)).not.toContain("ship the old way");
    expect(newest(3)).toContain("NEW BODY");   // what the tool returned
    expect(newest(3)).not.toContain("OLD BODY");

    await controller.submit("/deploy once more");
    expect(newest(4)).toContain("NEW BODY");   // what the slash invocation pasted
    expect(newest(4)).not.toContain("OLD BODY");
    await controller.shutdown();
  });
});

it("add, delete and rename take effect together, and the loader's guards still apply", async () => {
  const f = await fixture();
  await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nDEPLOY BODY", "utf8");
  await writeFile(join(f.skills, "stale.md"), "---\ndescription: d\n---\nSTALE BODY", "utf8");
  await session(f, async controller => {
    await controller.submit("/skills");
    expect(text(controller)).toContain("/stale");

    await rm(join(f.skills, "stale.md"));
    await rename(join(f.skills, "deploy.md"), join(f.skills, "release.md"));
    await writeFile(join(f.skills, "inspect.md"), "---\ndescription: d\n---\nINSPECT BODY", "utf8");
    // a symlink is not a skill, whatever it points at — the refresh runs the same loader
    await writeFile(join(f.root, "outside.md"), "---\ndescription: d\n---\nOUTSIDE BODY", "utf8");
    await symlink(join(f.root, "outside.md"), join(f.skills, "linked.md"));

    await controller.submit("/new");
    const reloaded = text(controller);
    expect(reloaded).toContain("added inspect, release");
    expect(reloaded).toContain("removed deploy, stale");

    await controller.submit("/inspect it");
    expect(newest(0)).toContain("INSPECT BODY");
    expect(newest(0)).not.toContain("OUTSIDE BODY");
    await controller.submit("/deploy it");
    expect(text(controller)).toContain("unknown command /deploy");
    await controller.submit("/linked it");
    expect(text(controller)).toContain("unknown command /linked");
    expect(requests).toHaveLength(1);
    await controller.shutdown();
  });
});

it("a refused rescan is reported and leaves the loaded catalogue in force", async () => {
  const f = await fixture();
  await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nOLD BODY", "utf8");
  await session(f, async controller => {
    controller.setSkillRefresh(() => Promise.reject(new Error("scan refused")));
    await controller.submit("/new");
    const printed = text(controller);
    expect(printed).toContain("skill catalogue refresh failed: scan refused");
    expect(printed).toContain("1 skill(s) already loaded are unchanged");
    expect(printed).not.toContain("skills reloaded");

    await controller.submit("/deploy now");
    expect(newest(0)).toContain("OLD BODY");
    await controller.shutdown();
  });
});

it("a rescan reaches only the roots this session was configured with", async () => {
  // an untrusted project contributes no skill root at all (config resolution, issue #61), and a
  // refresh must not become a second discovery that finds one
  const f = await fixture();
  await session({ root: f.root }, async controller => {
    await mkdir(join(f.root, ".agentrig", "skills"), { recursive: true });
    await writeFile(join(f.root, ".agentrig", "skills", "deploy.md"), "---\ndescription: d\n---\nUNCONFIGURED BODY", "utf8");
    await controller.submit("/new");
    expect(text(controller)).not.toContain("skills reloaded");
    await controller.submit("/skills");
    expect(text(controller)).toContain("no skills loaded");
    await controller.shutdown();
  });
});
