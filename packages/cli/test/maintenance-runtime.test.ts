import { execFile, fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { copyWiki, FileMemoryStore, inspectDreamWorkspace } from "@agentkitai/agentrig-memory";

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
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "memory", "lint", "--dir", root, "--dream-scan-limits", '{"maxEntries":1}'], { timeout: 5000 })
      .then(() => { throw new Error("expected CLI failure"); }, error => error as { code: number; stderr: string });
    expect(result.code).toBe(1); expect(result.stderr).toContain("entry limit");
    expect(result.stderr).toContain("auxiliary dream");
    expect(result.stderr).not.toContain("triggerUncaughtException"); expect(result.stderr).not.toMatch(/\n\s+at /);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("the built CLI requires explicit stamp-reset confirmation and preserves a usable backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-stamp-"));
  const cli = (...args: string[]) => promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "memory", "reset-dream-stamp", "--dir", root, ...args], { timeout: 5000 });
  try {
    const preview = await cli(); expect(preview.stdout).toContain("--confirm"); expect(preview.stdout).toContain("Nothing changed");
    expect(await readdir(root)).toEqual([]);
    const missing = await cli("--confirm").then(() => { throw new Error("expected missing wiki failure"); }, error => error);
    expect(missing.code).toBe(1); expect(await readdir(root)).toEqual([]);
    const wiki = join(root, "wiki"); await mkdir(wiki); const stamp = join(wiki, ".last-dream");
    const original = "bad stamp".repeat(1000); await writeFile(stamp, original);
    await cli(); expect(await readFile(stamp, "utf8")).toBe(original);
    const reset = await cli("--confirm"); expect(reset.stdout).toContain("Previous stamp preserved at");
    const backup = (await readdir(root)).find(name => name.startsWith("wiki.last-dream-before-reset-"))!;
    expect(backup).toBeDefined(); expect(await readFile(join(root, backup), "utf8")).toBe(original);
    expect(await readdir(wiki)).toEqual([]);
    expect((await cli("--confirm")).stdout).toContain("nothing changed");
    expect((await readdir(root)).filter(name => name.includes("before-reset"))).toEqual([backup]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

it("the built CLI previews without writing and binds confirmed discard to the previewed owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-cli-discard-"));
  try {
    const wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init();
    const ws = await copyWiki(wiki.root, join(root, "review copy")); await ws.release();
    const owner = (await inspectDreamWorkspace(ws.outputRoot)).owner;
    const cli = (...args: string[]) => promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "memory", "discard-dream", ws.outputRoot, ...args], { timeout: 5000 });
    const names = await readdir(root); const preview = await cli();
    expect(preview.stdout).toContain("owner: " + owner); expect(preview.stdout).toContain("producer: released");
    expect(preview.stdout).toContain("Nothing changed"); expect(await readdir(root)).toEqual(names);
    const missing = await cli("--confirm").catch(error => error);
    expect(missing.code).toBe(1); expect(missing.stderr).toContain("requires --owner");
    const mismatch = await cli("--confirm", "--owner", "00000000-0000-4000-8000-000000000000").catch(error => error);
    expect(mismatch.code).toBe(1); expect(mismatch.stderr).toContain("owner changed");
    expect(await readdir(root)).toEqual(names);
    const discarded = await cli("--confirm", "--owner", owner);
    expect(discarded.stdout).toContain("Discarded dream output and manifest");
    expect(discarded.stdout).toContain("not recoverable by this command");
    expect(await readdir(root)).toEqual(["wiki"]);
    expect((await cli("--confirm", "--owner", owner)).stdout).toContain("already absent");
    await ws.dispose(); // Still idempotent on the original runtime handle.
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
