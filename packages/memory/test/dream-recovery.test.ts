import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDream, copyWiki, discardDreamWorkspace, FileMemoryStore, FileRawStore, fingerprint,
  inspectDreamWorkspace, runDream } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm), open: vi.fn(actual.open) };
});
let root: string; let wiki: FileMemoryStore; let output: string;
const children: { child: ChildProcess; closed: Promise<void> }[] = [];
beforeEach(async () => {
  vi.mocked(fs.rename).mockReset(); vi.mocked(fs.rm).mockReset(); vi.mocked(fs.open).mockReset();
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "agentrig-dream-recovery-")));
  wiki = new FileMemoryStore({ root: join(root, "wiki") }); output = join(root, "output"); await wiki.init();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
  await fs.rm(root, { recursive: true, force: true });
});
const absent = (path: string) => expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
function message(child: ChildProcess, key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("producer did not send " + key)), 4000);
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("error", fail); child.off("close", closed); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const closed = () => fail(new Error("producer closed before " + key));
    const receive = (value: unknown) => {
      const msg = value as Record<string, unknown>;
      if (msg.error) fail(new Error(String(msg.error)));
      else if (msg[key]) { cleanup(); resolve(msg); }
    };
    child.on("message", receive); child.once("error", fail); child.once("close", closed);
  });
}
async function producer() {
  const child = fork(new URL("./fixtures/dream-producer.mjs", import.meta.url), [wiki.root, output],
    { stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve())); children.push({ child, closed });
  await message(child, "ready");
  return { child, closed };
}
async function send(child: ChildProcess, command: string, expected: string) {
  const waiting = message(child, expected); child.send(command); return waiting;
}

it("refuses a real active producer, then discards its explicitly released artifact while it stays alive", async () => {
  const before = await fingerprint(wiki.root); const { child } = await producer();
  const preview = await inspectDreamWorkspace(output);
  expect(preview).toMatchObject({ activity: "active", producer: { pid: child.pid } });
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("producer is active");
  await send(child, "release", "released");
  expect(child.exitCode).toBeNull(); expect((await inspectDreamWorkspace(output)).activity).toBe("released");
  expect(await discardDreamWorkspace(output, preview.owner)).toEqual({ status: "discarded" });
  await absent(output); await absent(preview.manifestPath); expect(await fingerprint(wiki.root)).toBe(before);
  expect(await discardDreamWorkspace(output, preview.owner)).toEqual({ status: "absent" });
}, 10_000);

it("recovers a real exited producer without inferring death from file age", async () => {
  const { child, closed } = await producer(); const preview = await inspectDreamWorkspace(output);
  child.kill("SIGKILL"); await closed;
  expect((await inspectDreamWorkspace(output)).activity).toBe("stopped");
  await discardDreamWorkspace(output, preview.owner); await absent(output); await absent(preview.manifestPath);
}, 10_000);

it("never reclaims even a confirmed crashed producer's writer lock", async () => {
  const { child, closed } = await producer(); const preview = await inspectDreamWorkspace(output);
  await send(child, "lock", "locked"); const lock = output + ".write.lock";
  const owner = await fs.readFile(lock, "utf8"); expect(owner.startsWith(child.pid + ":")).toBe(true);
  child.kill("SIGKILL"); await closed; expect((await inspectDreamWorkspace(output)).activity).toBe("stopped");
  await expect(discardDreamWorkspace(output, preview.owner, { timeoutMs: 5 })).rejects.toThrow("timed out waiting");
  expect(await fs.readFile(lock, "utf8")).toBe(owner); expect((await fs.stat(output)).isDirectory()).toBe(true);
  // Deliberate operator step on this stopped test fixture only, not production lock reclamation.
  await fs.rm(lock); await discardDreamWorkspace(output, preview.owner); await absent(output);
}, 10_000);

it("runDream hands off a completed review for persisted disposal in a still-running process", async () => {
  const result = await runDream({ wiki, raw: new FileRawStore({ root }), outputRoot: output, structuralOnly: true });
  const preview = await inspectDreamWorkspace(output);
  expect(preview).toMatchObject({ activity: "released", producer: { pid: process.pid } });
  await discardDreamWorkspace(output, preview.owner); await result.workspace.dispose();
});

it("refuses a changed owner UUID and a replaced output directory", async () => {
  const ws = await copyWiki(wiki.root, output); await ws.release();
  const preview = await inspectDreamWorkspace(output); const original = await fs.readFile(ws.manifestPath, "utf8");
  await fs.writeFile(ws.manifestPath, JSON.stringify({ ...JSON.parse(original), owner: randomUUID() }));
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("owner changed");
  await fs.writeFile(ws.manifestPath, original); await fs.rename(output, join(root, "original")); await fs.mkdir(output);
  await fs.writeFile(join(output, "keep"), "replacement");
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("workspace was replaced");
  expect(await fs.readFile(join(output, "keep"), "utf8")).toBe("replacement");
});

it("rechecks manifest ownership after lock acquisition, not only before waiting", async () => {
  const ws = await copyWiki(wiki.root, output); await ws.release(); const preview = await inspectDreamWorkspace(output);
  const original = JSON.parse(await fs.readFile(ws.manifestPath, "utf8")); const nextOwner = randomUUID();
  const actual = await vi.importActual<typeof fs>("node:fs/promises"); let injected = false;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]) === output + ".write.lock" && !injected) {
      injected = true; await fs.writeFile(ws.manifestPath, JSON.stringify({ ...original, owner: nextOwner }));
    }
    return handle;
  });
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("owner changed");
  expect(injected).toBe(true); expect((await inspectDreamWorkspace(output)).owner).toBe(nextOwner);
  expect((await fs.stat(output)).isDirectory()).toBe(true);
});

it("refuses symlinked roots and sidecars without deleting their targets", async () => {
  const ws = await copyWiki(wiki.root, output); await ws.release(); const preview = await inspectDreamWorkspace(output);
  await fs.rename(output, join(root, "original")); await fs.symlink(wiki.root, output, process.platform === "win32" ? "junction" : "dir");
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("symlinked/replaced");
  await fs.unlink(output); await fs.rename(join(root, "original"), output);
  const saved = join(root, "saved-manifest"); await fs.rename(ws.manifestPath, saved); await fs.symlink(saved, ws.manifestPath, "file");
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("invalid dream workspace manifest");
  expect((await fs.lstat(ws.manifestPath)).isSymbolicLink()).toBe(true); expect(await fs.readFile(saved, "utf8")).toContain(preview.owner);
});

it.each(["missing", "corrupt", "oversized", "version"])("preserves an artifact with %s ownership evidence", async kind => {
  const ws = await copyWiki(wiki.root, output); await ws.release(); const preview = await inspectDreamWorkspace(output);
  if (kind === "missing") await fs.rm(ws.manifestPath);
  else await fs.writeFile(ws.manifestPath, kind === "corrupt" ? "{" : kind === "oversized" ? "x".repeat(65537) : '{"version":999}');
  await expect(discardDreamWorkspace(output, preview.owner, { maxFileBytes: 1_000_000 })).rejects.toThrow();
  expect((await fs.stat(output)).isDirectory()).toBe(true);
});

it("keeps legacy manifests applicable but refuses to invent inactive producer ownership for discard", async () => {
  const ws = await copyWiki(wiki.root, output);
  const manifest = JSON.parse(await fs.readFile(ws.manifestPath, "utf8")); delete manifest.producer; delete manifest.released; manifest.version = 1;
  await fs.writeFile(ws.manifestPath, JSON.stringify(manifest));
  const preview = await inspectDreamWorkspace(output); expect(preview.activity).toBe("legacy");
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("producer is legacy");
  const backup = await applyDream(wiki.root, output, "legacy"); expect((await fs.stat(backup)).isDirectory()).toBe(true);
});

it("refuses foreign hosts and uncertain PID checks rather than treating them as dead", async () => {
  const ws = await copyWiki(wiki.root, output); const manifest = JSON.parse(await fs.readFile(ws.manifestPath, "utf8"));
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  expect((await inspectDreamWorkspace(output)).activity).toBe("unknown");
  await expect(discardDreamWorkspace(output, manifest.owner)).rejects.toThrow("producer is unknown"); kill.mockRestore();
  await fs.writeFile(ws.manifestPath, JSON.stringify({ ...manifest, released: true, producer: { ...manifest.producer, host: "foreign-" + manifest.producer.host } }));
  await expect(discardDreamWorkspace(output, manifest.owner)).rejects.toThrow("producer is unknown");
});

it("preserves the manifest for retry if final sidecar removal fails after output disposal", async () => {
  const ws = await copyWiki(wiki.root, output); await ws.release(); const preview = await inspectDreamWorkspace(output);
  const actual = await vi.importActual<typeof fs>("node:fs/promises"); let injected = false;
  vi.mocked(fs.rm).mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === ws.manifestPath && !injected) { injected = true; throw new Error("busy sidecar"); }
    return actual.rm(...args);
  });
  await expect(discardDreamWorkspace(output, preview.owner)).rejects.toThrow("dream discard incomplete; inspect " + output);
  await absent(output); expect((await inspectDreamWorkspace(output)).owner).toBe(preview.owner);
  await discardDreamWorkspace(output, preview.owner); await absent(ws.manifestPath);
});

it("pre-abort does no work, but abort after output deletion finishes its owned sidecar cleanup", async () => {
  const ws = await copyWiki(wiki.root, output); await ws.release(); const preview = await inspectDreamWorkspace(output);
  const stopped = new AbortController(); stopped.abort();
  await expect(discardDreamWorkspace(output, preview.owner, { signal: stopped.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect((await fs.stat(output)).isDirectory()).toBe(true);
  const controller = new AbortController(); const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rm).mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    await actual.rm(...args); if (String(args[0]) === output) controller.abort();
  });
  expect(await discardDreamWorkspace(output, preview.owner, { signal: controller.signal })).toEqual({ status: "discarded" });
  await absent(ws.manifestPath);
});

it("reports failed runtime handoff without discarding a completed artifact or claiming it was released", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(to) === output + ".dream.json") throw new Error("handoff rename failed");
    return actual.rename(from, to);
  });
  const warnings: Error[] = [];
  const result = await runDream({ wiki, raw: new FileRawStore({ root }), outputRoot: output, structuralOnly: true, onError: error => warnings.push(error) });
  expect(result.auxiliary).toMatchObject({ outcome: "completed", localCommitState: "completed" });
  expect(warnings.some(error => error.message.includes("ownership handoff failed"))).toBe(true);
  expect((await inspectDreamWorkspace(output)).activity).toBe("active");
  expect((await fs.readdir(root)).some(name => name.endsWith(".tmp"))).toBe(false);
  await result.workspace.dispose();
});

it("does not remove a pre-existing handoff temp when exclusive creation fails", async () => {
  const ws = await copyWiki(wiki.root, output); const actual = await vi.importActual<typeof fs>("node:fs/promises"); let saved = "";
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).startsWith(ws.manifestPath + ".") && String(args[0]).endsWith(".tmp")) {
      saved = String(args[0]); await fs.writeFile(saved, "other owner");
    }
    return actual.open(...args);
  });
  await expect(ws.release()).rejects.toMatchObject({ code: "EEXIST" });
  expect(saved).not.toBe(""); expect(await fs.readFile(saved, "utf8")).toBe("other owner");
  expect((await inspectDreamWorkspace(output)).activity).toBe("active"); await ws.dispose();
});
