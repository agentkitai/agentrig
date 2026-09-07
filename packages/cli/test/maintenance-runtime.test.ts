import { execFile, fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { copyWiki, FileMemoryStore, inspectDreamWorkspace } from "@agentkitai/agentrig-memory";

/** Keep each actual CLI's 5s bound and join close on success/failure before fixture cleanup. */
function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  let closed: Promise<void>;
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath,
      [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "memory", ...args],
      { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8" }, (error, stdout, stderr) => {
        if (error !== null) {
          error.message = `CLI subprocess (5000ms bound; code=${error.code ?? "null"}; killed=${error.killed === true}; signal=${error.signal ?? "none"}): ${error.message}`;
          reject(Object.assign(error, { stdout, stderr }));
        }
        else resolve({ stdout, stderr });
      });
    closed = new Promise<void>(resolveClose => { child.once("close", () => resolveClose()); });
  });
  return result.finally(() => closed);
}

it.each(["cooperative", "stuck"])("handles interruption of %s maintenance in a real child process", async mode => {
  const child = fork(fileURLToPath(new URL("./fixtures/maintenance-interrupt.mjs", import.meta.url)), [mode], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
  });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
  let timer: NodeJS.Timeout | undefined;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", code => resolve(code)); child.once("error", reject);
  });
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("maintenance fixture did not exit")), 5000); });
  child.once("message", () => {
    child.send("interrupt");
    if (mode === "stuck") child.send("force interrupt");
  });
  try {
    expect(await Promise.race([exited, deadline])).toBe(130);
    expect(stderr).toContain("cancelling memory maintenance");
    if (mode === "stuck") expect(stderr).toContain("forcing exit; interrupted maintenance may leave locks or artifacts requiring recovery");
    else { expect(stderr).toContain("remaining SIGINT listeners: 0"); expect(stderr).not.toContain("forcing exit"); }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
}, 10_000);

it("the built CLI prints a maintenance failure without an unhandled-rejection stack", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-maintenance-"));
  try {
    const result = await runCli("lint", "--dir", root, "--dream-scan-limits", '{"maxEntries":1}')
      .then(() => { throw new Error("expected CLI failure"); }, error => error as { code: number; stderr: string });
    expect(result.code).toBe(1); expect(result.stderr).toContain("entry limit");
    expect(result.stderr).toContain("auxiliary dream");
    expect(result.stderr).not.toContain("triggerUncaughtException"); expect(result.stderr).not.toMatch(/\n\s+at /);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The former single cases each ran five sequential CLIs under one 15s fixture deadline,
// although every CLI legitimately has its own 5s bound. Independent fixtures keep at most
// two dependent calls (preview/confirm or confirm/repeat) inside the unchanged 15s deadline.
it.each(["preview without wiki", "confirmation without wiki", "preview existing stamp", "confirmed reset", "idempotent reset"])(
  "the built CLI handles stamp-reset %s without losing backup evidence", async mode => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-stamp-"));
  const cli = (...args: string[]) => runCli("reset-dream-stamp", "--dir", root, ...args);
  try {
    if (mode === "preview without wiki") {
      const preview = await cli(); expect(preview.stdout).toContain("--confirm"); expect(preview.stdout).toContain("Nothing changed");
      expect(await readdir(root)).toEqual([]);
      return;
    }
    if (mode === "confirmation without wiki") {
      const missing = await cli("--confirm").then(() => { throw new Error("expected missing wiki failure"); }, error => error);
      expect(missing.code).toBe(1); expect(await readdir(root)).toEqual([]);
      return;
    }
    const wiki = join(root, "wiki"); await mkdir(wiki); const stamp = join(wiki, ".last-dream");
    const original = "bad stamp".repeat(1000); await writeFile(stamp, original);
    if (mode === "preview existing stamp") {
      const preview = await cli(); expect(preview.stdout).toContain("--confirm"); expect(preview.stdout).toContain("Nothing changed");
      expect(await readFile(stamp, "utf8")).toBe(original);
      expect(await readdir(root)).toEqual(["wiki"]);
      return;
    }
    const reset = await cli("--confirm"); expect(reset.stdout).toContain("Previous stamp preserved at");
    const backup = (await readdir(root)).find(name => name.startsWith("wiki.last-dream-before-reset-"))!;
    expect(backup).toBeDefined(); expect(await readFile(join(root, backup), "utf8")).toBe(original);
    expect(await readdir(wiki)).toEqual([]);
    if (mode === "idempotent reset") {
      expect((await cli("--confirm")).stdout).toContain("nothing changed");
      expect(await readFile(join(root, backup), "utf8")).toBe(original);
      expect(await readdir(wiki)).toEqual([]);
    }
    expect((await readdir(root)).filter(name => name.includes("before-reset"))).toEqual([backup]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

it.each(["preview", "missing owner", "mismatched owner", "preview then confirm", "idempotent discard"])(
  "the built CLI handles dream-discard %s with owner-bound artifacts", async mode => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-discard-"));
  try {
    const wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init();
    const ws = await copyWiki(wiki.root, join(root, "review copy")); await ws.release();
    const owner = (await inspectDreamWorkspace(ws.outputRoot)).owner;
    const cli = (...args: string[]) => runCli("discard-dream", ws.outputRoot, ...args);
    const names = await readdir(root);
    const manifest = await readFile(ws.manifestPath, "utf8");
    const index = await readFile(join(ws.outputRoot, "index.md"), "utf8");
    if (mode === "preview" || mode === "preview then confirm") {
      const preview = await cli();
      expect(preview.stdout).toContain("owner: " + owner); expect(preview.stdout).toContain("producer: released");
      expect(preview.stdout).toContain("Nothing changed"); expect(await readdir(root)).toEqual(names);
      expect(await readFile(ws.manifestPath, "utf8")).toBe(manifest);
      expect(await readFile(join(ws.outputRoot, "index.md"), "utf8")).toBe(index);
      if (mode === "preview") return;
    }
    if (mode === "missing owner" || mode === "mismatched owner") {
      const args = mode === "missing owner" ? ["--confirm"] : ["--confirm", "--owner", "00000000-0000-4000-8000-000000000000"];
      const refused = await cli(...args).catch(error => error);
      expect(refused.code).toBe(1); expect(refused.stderr).toContain(mode === "missing owner" ? "requires --owner" : "owner changed");
      expect(await readdir(root)).toEqual(names);
      expect(await readFile(ws.manifestPath, "utf8")).toBe(manifest);
      expect(await readFile(join(ws.outputRoot, "index.md"), "utf8")).toBe(index);
      return;
    }
    const discarded = await cli("--confirm", "--owner", owner);
    expect(discarded.stdout).toContain("Discarded dream output and manifest");
    expect(discarded.stdout).toContain("not recoverable by this command");
    expect(await readdir(root)).toEqual(["wiki"]);
    if (mode === "idempotent discard") expect((await cli("--confirm", "--owner", owner)).stdout).toContain("already absent");
    await ws.dispose(); // Still idempotent on the original runtime handle.
    expect(await readdir(root)).toEqual(["wiki"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
