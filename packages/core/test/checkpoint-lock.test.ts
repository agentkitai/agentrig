import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Checkpointer, createAgent, inspectCheckpointLock, recoverCheckpointLock, RulePolicy, SessionStore, writeFileTool,
  type ModelProvider } from "@agentkitai/agentrig-core";

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-checkpoint-lock-"))); roots.push(root);
  await exec("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "file"), "before"); await exec("git", ["add", "file"], { cwd: root });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"], { cwd: root });
  const path = join(root, ".git", "agentrig-checkpoint.lock");
  const ctx = { point: "pre_tool" as const, cwd: root, sessionId: "lock_fixture", turn: 1,
    signal: new AbortController().signal, emitCheckpoint: async () => {} };
  return { root, path, ctx };
}

it("held legacy lock diagnostic names the exact shared lock path", async () => {
  const f = await fixture(); await mkdir(f.path);
  await expect(new Checkpointer().handler(f.ctx)).rejects.toThrow(JSON.stringify(f.path));
});

it("new leases record bounded owner identity and remove only their own metadata on release", async () => {
  const f = await fixture(); const cp = new Checkpointer();
  try {
    await cp.handler(f.ctx);
    const bytes = await readFile(join(f.path, "owner.json"), "utf8");
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(bytes)).toMatchObject({ version: 1, pid: process.pid, sessionId: "lock_fixture", repo: f.root });
  } finally { await cp.endSession(f.ctx.sessionId); }
});

it("live owner refuses recovery even with a copied inspection token and every acknowledgment", async () => {
  const f = await fixture(); const cp = new Checkpointer(); await cp.handler(f.ctx);
  try {
    const seen = await inspectCheckpointLock(f.root); expect(seen.state).toBe("live-owner");
    await expect(recoverCheckpointLock(f.root, { expectedToken: seen.token!, confirmQuiescent: true, acknowledgeLegacyEmpty: true })).rejects.toThrow("owner death not established");
    expect((await inspectCheckpointLock(f.root)).token).toBe(seen.token);
  } finally { if ((await inspectCheckpointLock(f.root)).state !== "missing") await cp.endSession(f.ctx.sessionId); }
});

async function editAndSeal(root: string) {
  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") }); let turn = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() { if (turn++ === 0) yield { type: "tool_use", id: "write", name: "write_file", input: { path: "file", content: "after" } }; yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" }; } };
  const session = createAgent({ provider, store, repoMap: false, tools: [writeFileTool()], hooks: [new Checkpointer()],
    systemPrompt: "fixture", permissions: new RulePolicy([{ decision: "allow" }]) }).run("write file", { cwd: root });
  expect((await session.done).reason).toBe("done"); const events = await store.readAll(session.id);
  expect(events.some(e => e.type === "checkpoint.created")).toBe(true); expect(events.some(e => e.type === "checkpoint.sealed")).toBe(true);
  expect(await readFile(join(root, "file"), "utf8")).toBe("after"); expect((await inspectCheckpointLock(root)).state).toBe("missing");
}

it("legacy empty recovery needs both explicit acknowledgments, preserves identity, then permits a real edit/seal", async () => {
  const f = await fixture(); await mkdir(f.path); const seen = await inspectCheckpointLock(f.root);
  expect(seen.state).toBe("legacy-empty");
  await expect(recoverCheckpointLock(f.root, { expectedToken: seen.token!, confirmQuiescent: false, acknowledgeLegacyEmpty: true })).rejects.toThrow("stopped-writers");
  await expect(recoverCheckpointLock(f.root, { expectedToken: seen.token!, confirmQuiescent: true })).rejects.toThrow("legacy acknowledgment");
  const recovered = await recoverCheckpointLock(f.root, { expectedToken: seen.token!, confirmQuiescent: true, acknowledgeLegacyEmpty: true });
  expect(recovered.path).toBe(f.path); expect((await inspectCheckpointLock(f.root)).state).toBe("missing");
  expect(await realpath(recovered.preservedAt)).toBe(recovered.preservedAt);
  await editAndSeal(f.root);
});

it("a joined exited owner can be recovered without deleting metadata and the next edit still seals", async () => {
  const f = await fixture();
  const module = pathToFileURL(resolve("packages/core/dist/index.js")).href;
  await exec(process.execPath, ["--input-type=module", "-e", `import {Checkpointer} from ${JSON.stringify(module)};
    const cp = new Checkpointer(); await cp.handler({point:'pre_tool',cwd:${JSON.stringify(f.root)},sessionId:'departed',turn:1,signal:new AbortController().signal,emitCheckpoint:async()=>{}});`]);
  const seen = await inspectCheckpointLock(f.root); expect(seen.state).toBe("dead-owner");
  const bytes = await readFile(join(f.path, "owner.json"));
  const recovered = await recoverCheckpointLock(f.root, { expectedToken: seen.token!, confirmQuiescent: true });
  expect(await readFile(join(recovered.preservedAt, "owner.json"))).toEqual(bytes);
  await editAndSeal(f.root);
}, 15_000);

it("changed directory identity, cancellation and unknown contents never become recovery authority", async () => {
  const f = await fixture(); await mkdir(f.path); const seen = await inspectCheckpointLock(f.root);
  const options = { expectedToken: seen.token!, confirmQuiescent: true, acknowledgeLegacyEmpty: true };
  const abort = new AbortController(); abort.abort(); await expect(recoverCheckpointLock(f.root, { ...options, signal: abort.signal })).rejects.toThrow();
  await rename(f.path, f.path + ".original"); await mkdir(f.path);
  await expect(recoverCheckpointLock(f.root, options)).rejects.toThrow("identity changed");
  await writeFile(join(f.path, "unknown"), "KEEP");
  await expect(inspectCheckpointLock(f.root)).rejects.toThrow("unknown contents");
  await expect(recoverCheckpointLock(f.root, options)).rejects.toThrow("unknown contents");
  expect(await readFile(join(f.path, "unknown"), "utf8")).toBe("KEEP");
});

it("malformed, foreign-host and modified owner records are retained, never treated as dead", async () => {
  const f = await fixture(); const cp = new Checkpointer(); await cp.handler(f.ctx);
  const ownerPath = join(f.path, "owner.json"); const bytes = await readFile(ownerPath, "utf8"); const seen = await inspectCheckpointLock(f.root);
  await writeFile(ownerPath, JSON.stringify({ ...JSON.parse(bytes), host: "unknown-host.invalid" }));
  expect((await inspectCheckpointLock(f.root)).state).toBe("unknown-owner");
  const changed = await inspectCheckpointLock(f.root);
  await expect(recoverCheckpointLock(f.root, { expectedToken: changed.token!, confirmQuiescent: true })).rejects.toThrow("owner death not established");
  await expect(cp.endSession(f.ctx.sessionId)).rejects.toThrow("lease replaced");
  await writeFile(ownerPath, "SECRET_MALFORMED");
  await expect(recoverCheckpointLock(f.root, { expectedToken: seen.token!, confirmQuiescent: true })).rejects.toThrow("malformed owner metadata retained");
  expect(await readFile(ownerPath, "utf8")).toBe("SECRET_MALFORMED");
});

it("symlinked lock directories refuse without changing the target", async () => {
  const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "KEEP");
  await symlink(outside, f.path, process.platform === "win32" ? "junction" : "dir");
  await expect(inspectCheckpointLock(f.root)).rejects.toThrow("not a symlink");
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("KEEP");
});

it("an owned lock containing unexpected data is not cleaned up", async () => {
  const f = await fixture(); const cp = new Checkpointer(); await cp.handler(f.ctx);
  const owner = await readFile(join(f.path, "owner.json")); await writeFile(join(f.path, "foreign"), "KEEP");
  await expect(cp.endSession(f.ctx.sessionId)).rejects.toThrow("lease replaced");
  expect(await readFile(join(f.path, "owner.json"))).toEqual(owner);
  expect(await readFile(join(f.path, "foreign"), "utf8")).toBe("KEEP");
});
