import { spawn } from "node:child_process";
import { lstat, mkdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { activeSandboxPolicy, sandboxSpawnInvocation, throwIfSandboxDenied } from "../sandbox-providers.js";
import { SandboxDeniedError } from "../sandbox.js";

/** Resolve existing aliases, including a dangling final symlink and missing parent directories. */
async function writeTarget(path: string, depth = 0): Promise<string> {
  if (depth > 128) throw new Error("file-write target has too many unresolved path components or symlinks");
  try { return await realpath(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return undefined;
  });
  if (info?.isSymbolicLink()) {
    const target = await readlink(path);
    // Relative link targets are relative to the physical parent. Preserve embedded '..'
    // until realpath resolves it, rather than collapsing it across unresolved symlinks.
    return writeTarget(isAbsolute(target) ? target : `${await realpath(dirname(path))}${sep}${target}`, depth + 1);
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`cannot resolve file-write target: ${path}`);
  return join(await writeTarget(parent, depth + 1), basename(path));
}

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
  const absolute = await writeTarget(path);
  const canonicalCwd = await realpath(policy.cwd);
  const rel = relative(canonicalCwd, absolute);
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
  // Map physical host paths back into the provider's bind/profile namespace when cwd is an alias.
  const target = resolve(policy.cwd, rel);
  const invocation = sandboxSpawnInvocation("/bin/sh", ["-c", script, "agentrig-write", target, mode], policy.cwd);
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
