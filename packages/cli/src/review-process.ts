import { spawn } from "node:child_process";

export interface ReviewProcessOptions { cwd: string; signal: AbortSignal; input?: string; maxBytes?: number }
export type ReviewProcess = (program: "git" | "gh", args: string[], options: ReviewProcessOptions) => Promise<string>;

/** Fixed trusted binaries, no shell. Cancellation joins the owned child and its kill request. */
export const reviewProcess: ReviewProcess = (program, args, options) => new Promise((resolve, reject) => {
  options.signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GH_PAGER: "cat", PAGER: "cat", LC_ALL: "C" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete env[key as keyof typeof env];
  delete (env as NodeJS.ProcessEnv).GH_REPO; delete (env as NodeJS.ProcessEnv).GH_HOST;
  const child = spawn(program, args, { cwd: options.cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let failed = false, bytes = 0;
  const stdout: Buffer[] = [];
  let killing: Promise<void> | undefined;
  const stop = () => {
    failed = true;
    if (killing !== undefined) return;
    killing = new Promise<void>(done => {
      if (child.pid === undefined) { done(); return; }
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        done(); return;
      }
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const bound = setTimeout(() => { killer.kill(); child.kill(); }, 10_000);
      const settled = () => { clearTimeout(bound); done(); };
      killer.once("error", settled); killer.once("close", settled);
    });
  };
  const timer = setTimeout(stop, 15_000);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > Math.min(options.maxBytes ?? 65_536, 65_536)) { stop(); return; }
    if (stream === child.stdout && !failed) stdout.push(chunk);
  });
  child.once("error", () => { failed = true; });
  child.once("close", async code => {
    clearTimeout(timer); options.signal.removeEventListener("abort", stop);
    await killing;
    if (failed || code !== 0 || options.signal.aborted) reject(new Error("review subprocess refused, failed, exceeded its bound or was cancelled"));
    else resolve(Buffer.concat(stdout).toString("utf8"));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
});
