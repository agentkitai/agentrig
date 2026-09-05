import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { activeSandboxPolicy, sandboxSpawnInvocation, throwIfSandboxDenied } from "../sandbox-providers.js";
import { SandboxDeniedError } from "../sandbox.js";

/** File bytes travel on stdin, never as shell source or argv. The OS checks the final open,
 * including symlinks that change after any host-side check. Unsandboxed behavior is unchanged. */
export async function writeToolFile(path: string, content: string, signal: AbortSignal, parents = false): Promise<void> {
  signal.throwIfAborted();
  const policy = activeSandboxPolicy();
  if (policy === undefined) {
    if (parents) await mkdir(dirname(path), { recursive: true });
    signal.throwIfAborted();
    await writeFile(path, content, { encoding: "utf8", signal });
    return;
  }
  const absolute = resolve(path);
  const rel = relative(policy.cwd, absolute);
  if (policy.mode === "read-only" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SandboxDeniedError(`sandbox ${policy.mode} refuses file write: ${absolute}`);
  }
  // A sibling temp + rename never truncates the old target if input or execution is interrupted.
  // Replacing the directory entry also avoids mutating a pre-existing hardlink's outside inode.
  const existing = await stat(absolute).catch(() => undefined);
  if (existing?.isDirectory()) throw new Error(`cannot write a directory: ${absolute}`);
  const mode = (existing === undefined ? 0o666 & ~process.umask() : existing.mode & 0o777).toString(8);
  const script = (parents ? 'mkdir -p -- "$(dirname -- "$1")" || exit; ' : "") +
    't=$(mktemp "$(dirname -- "$1")/.agentrig-write-XXXXXX") || exit; ' +
    'trap \'rm -f -- "$t"\' EXIT HUP INT TERM; ' +
    'cat > "$t" && chmod "$2" "$t" && mv -f -- "$t" "$1"';
  const invocation = sandboxSpawnInvocation("/bin/sh", ["-c", script, "agentrig-write", absolute, mode], policy.cwd);
  if (!invocation.sandboxed) throw new SandboxDeniedError("the configured provider has no sandboxed file-write launcher");
  const child = spawn(invocation.command, invocation.args, {
    cwd: policy.cwd, stdio: ["pipe", "ignore", "pipe"], detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-8192); });
  const kill = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; kill(); }, 30_000);
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  // A refused open can close stdin before all bytes are sent. Report the process outcome.
  child.stdin.on("error", () => {});
  try {
    const done = new Promise<number | null>((res, rej) => {
      child.on("error", rej);
      child.on("close", res);
    });
    child.stdin.end(content, "utf8");
    const code = await done;
    signal.throwIfAborted();
    if (timedOut) throw new Error("sandbox file write timed out after 30000ms");
    if (code !== 0) {
      throwIfSandboxDenied(stderr);
      throw new Error(`sandbox file write failed (${code}): ${stderr.trim()}`);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}
