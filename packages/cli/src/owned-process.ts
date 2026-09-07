import { spawn } from "node:child_process";

/** Internal trusted callers only: no config command surface. Joins exact owned child and kill request. */
export interface OwnedProcessOptions {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string;
  timeoutMs: number; maxBytes: number; errorMessage: string;
}
export const ownedProcess = (program: string, args: string[], options: OwnedProcessOptions): Promise<string> => new Promise((resolve, reject) => {
  options.signal.throwIfAborted();
  const child = spawn(program, args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
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
  const timer = setTimeout(stop, options.timeoutMs);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > options.maxBytes) { stop(); return; }
    if (stream === child.stdout && !failed) stdout.push(chunk);
  });
  child.once("error", () => { failed = true; });
  child.once("close", async code => {
    clearTimeout(timer); options.signal.removeEventListener("abort", stop);
    await killing;
    if (failed || code !== 0 || options.signal.aborted) reject(new Error(options.errorMessage));
    else resolve(Buffer.concat(stdout).toString("utf8"));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
});
