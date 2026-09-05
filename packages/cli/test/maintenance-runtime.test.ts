import { execFile, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

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
});

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
