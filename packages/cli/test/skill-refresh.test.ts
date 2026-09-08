import { mkdir, mkdtemp, realpath, rm, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
import { addPackage } from "../src/packages.js";

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
import { startTui, type TuiOptions } from "../src/tui/start.js";

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

/**
 * Installs a real package bundle into the fixture project, the same way `agentrig package add`
 * does: the install record `inspectPackages` checks at startup is written by the actual installer,
 * not by the test.
 */
async function installPackage(root: string, options: { body: string; version?: string }): Promise<string> {
  const source = await mkdtemp(join(root, "bundle-"));
  await writeFile(join(source, "package.json"),
    JSON.stringify({ name: "fixture", version: options.version ?? "1", agentrig: { apiVersion: 1 } }), "utf8");
  await mkdir(join(source, "skills"));
  await writeFile(join(source, "skills", "audit.md"), `---\nname: audit\ndescription: package audit\n---\n${options.body}`, "utf8");
  const installed = await addPackage({ projectRoot: root, source });
  await rm(source, { recursive: true, force: true });
  return installed.destination;
}

/** Runs the real startup, then the caller's script against the controller it mounted. */
async function session(f: { root: string; skills?: string }, exercise: (controller: TuiController) => Promise<void>,
  overrides: Partial<TuiOptions> = {}): Promise<void> {
  harness.exercise = exercise;
  await startTui({ root: join(f.root, "logs"), provider: "fixture", model: "fixture", repoMap: false,
    maxTurns: "5", maxTokensPerTurn: "1000", skillDiscovery: false, packages: false, allow: ["skill"],
    ...(f.skills === undefined ? {} : { skills: [f.skills] }), ...overrides });
}

/** A promise the test settles by hand, so a rescan can be observed while it is still in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
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
    const outside = join(f.root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "---\nname: linked\ndescription: d\n---\nOUTSIDE BODY", "utf8");
    await symlink(outside, join(f.skills, "linked"), process.platform === "win32" ? "junction" : "dir");

    await controller.submit("/new");
    const reloaded = text(controller);
    expect(reloaded).toContain("added inspect, release");
    expect(reloaded).toContain("removed deploy, stale");
    // completion is one of the four consumers, and it is the one nothing else in this file would
    // notice: a rename that reached the loader but not the completion list still offers /deploy
    const names = controller.completionCandidates();
    expect(names).toContainEqual({ name: "inspect", kind: "skill" });
    expect(names).toContainEqual({ name: "release", kind: "skill" });
    expect(names.map(candidate => candidate.name)).not.toContain("deploy");
    expect(names.map(candidate => candidate.name)).not.toContain("stale");
    expect(names.map(candidate => candidate.name)).not.toContain("linked");

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
  // refresh must not become a second discovery that finds one. The session starts WITH a
  // configured skill on purpose: a refresh that never runs would pass this by doing nothing, so
  // the same `/new` has to be seen picking the configured edit up while leaving the other root
  // alone.
  const f = await fixture();
  await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nCONFIGURED OLD", "utf8");
  await session(f, async controller => {
    await mkdir(join(f.root, ".agentrig", "skills"), { recursive: true });
    await writeFile(join(f.root, ".agentrig", "skills", "unconfigured.md"), "---\ndescription: u\n---\nUNCONFIGURED BODY", "utf8");
    await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nCONFIGURED NEW", "utf8");

    await controller.submit("/new");
    expect(text(controller)).toContain("skills reloaded: updated deploy");
    expect(controller.completionCandidates().map(candidate => candidate.name)).not.toContain("unconfigured");
    await controller.submit("/skills");
    const printed = text(controller);
    expect(printed).toContain("/deploy");
    expect(printed).not.toContain("/unconfigured");

    await controller.submit("/deploy it");
    expect(newest(0)).toContain("CONFIGURED NEW");
    expect(newest(0)).not.toContain("UNCONFIGURED BODY");
    await controller.submit("/unconfigured it");
    expect(text(controller)).toContain("unknown command /unconfigured");
    expect(requests).toHaveLength(1);
    await controller.shutdown();
  });
});

it("an installed package edited after startup is refused, and the whole generation stays put", async () => {
  const f = await fixture();
  await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nOLD BODY", "utf8");
  const installed = await installPackage(f.root, { body: "PACKAGE BODY" });
  const record = join(installed, "skills", "audit.md");
  const recorded = "---\nname: audit\ndescription: package audit\n---\nPACKAGE BODY";
  await session(f, async controller => {
    await controller.submit("/audit it");
    expect(newest(0)).toContain("PACKAGE BODY");

    // exactly what a restart refuses: the installed bytes no longer match the install record
    await writeFile(record, "---\nname: audit\ndescription: package audit\n---\nTAMPERED BODY", "utf8");
    await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nNEW BODY", "utf8");
    await controller.submit("/new");
    let printed = text(controller);
    expect(printed).toContain("skill catalogue refresh failed: installed package fixture no longer passes its integrity check");
    expect(printed).not.toContain("skills reloaded");

    // all-or-nothing: neither the tampered package body nor the legitimate configured-root edit
    // landed, because the refusal happened before anything was swapped
    await controller.submit("/audit it");
    expect(newest(1)).toContain("PACKAGE BODY");
    expect(newest(1)).not.toContain("TAMPERED BODY");
    await controller.submit("/deploy it");
    expect(newest(2)).toContain("OLD BODY");
    expect(newest(2)).not.toContain("NEW BODY");

    // the positive control: restoring the recorded bytes makes the very same `/new` succeed, so
    // the guard is a check and not a blanket refusal of every refresh in a packaged project
    await writeFile(record, recorded, "utf8");
    await controller.submit("/new");
    expect(text(controller)).toContain("skills reloaded: updated deploy");
    await controller.submit("/deploy it");
    expect(newest(3)).toContain("NEW BODY");
    await controller.submit("/audit it");
    expect(newest(4)).toContain("PACKAGE BODY");

    // an unrecorded file dropped beside a recorded one is the other half of the same hole: the
    // plain skill loader would happily read it, the install record does not list it
    await writeFile(join(installed, "skills", "extra.md"), "---\nname: extra\ndescription: e\n---\nEXTRA BODY", "utf8");
    await controller.submit("/new");
    expect(text(controller)).toContain("skill catalogue refresh failed: installed package fixture");
    await controller.submit("/extra it");
    expect(text(controller)).toContain("unknown command /extra");
    await rm(join(installed, "skills", "extra.md"));

    // and a package uninstalled and replaced under the same name is new content, not the bundle
    // this session was admitted with — a refresh is not where that trust decision gets remade
    await rm(installed, { recursive: true, force: true });
    await installPackage(f.root, { body: "REPLACEMENT BODY", version: "2" });
    await controller.submit("/new");
    printed = text(controller);
    expect(printed).toContain("skill catalogue refresh failed: installed package fixture");
    await controller.submit("/audit it");
    expect(newest(5)).toContain("PACKAGE BODY");
    expect(newest(5)).not.toContain("REPLACEMENT BODY");
    expect(requests).toHaveLength(6);
    await controller.shutdown();
  }, { packages: true, skillDiscovery: true, trustedProjectRoot: f.root });
});

it("a rescan in flight defers other work, is joined by shutdown, and settles as one generation", async () => {
  const f = await fixture();
  await writeFile(join(f.skills, "deploy.md"), "---\ndescription: d\n---\nOLD BODY", "utf8");
  const gate = deferred(); const entered = deferred();
  // The real refresh, held open — not a stand-in. Wrapping what `startTui` installs keeps the
  // catalogue, the `skill` tool and the slash surface the production ones, so what settles at the
  // end is a real generation rather than something the test made up.
  const install = TuiController.prototype.setSkillRefresh;
  vi.spyOn(TuiController.prototype, "setSkillRefresh").mockImplementation(function (this: TuiController, refresh) {
    install.call(this, async () => { entered.resolve(); await gate.promise; return refresh(); });
  });
  await session(f, async controller => {
    await controller.submit("/deploy now");
    expect(newest(0)).toContain("OLD BODY");
    await rename(join(f.skills, "deploy.md"), join(f.skills, "release.md"));

    const refreshing = controller.submit("/new");
    await entered.promise;

    // a prompt submitted while the scan runs must not start a turn: it would compose from one
    // generation and call tools built from another
    await controller.submit("do work now");
    expect(text(controller)).toContain("a turn is already running");
    await controller.submit("/skills");
    expect(text(controller)).toContain("maintenance or provider selection is running");
    expect(requests).toHaveLength(1);
    // nothing is half-applied while it is in flight, either
    expect(controller.completionCandidates().map(candidate => candidate.name)).toContain("deploy");
    expect(controller.completionCandidates().map(candidate => candidate.name)).not.toContain("release");

    // `/abort` does not tear the scan in half, and shutdown does not return before it settles
    controller.abort();
    expect(text(controller)).toContain("cancelling conversation startup");
    const closing = controller.shutdown();
    expect(await Promise.race([closing.then(() => "closed"), delay(50, "pending")])).toBe("pending");
    gate.resolve();
    await closing; await refreshing;

    expect(text(controller)).toContain("skills reloaded: added release; removed deploy");
    const names = controller.completionCandidates().map(candidate => candidate.name);
    expect(names).toContain("release");
    expect(names).not.toContain("deploy");
    expect(requests).toHaveLength(1);
  });
});
