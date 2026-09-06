import { execFile } from "node:child_process";
import { mkdir, mkdtemp, lstat, readdir, realpath, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { checkpointState, git, gitEnvironment, inside, sameCheckpointState } from "./checkpointer.js";
import type { ToolContext } from "./tool.js";

const MIB = 1024 * 1024;
const MAX_RETAINED = 8;
const MAX_BYTES = 512 * MIB;
const PATCH_BYTES = 8 * MIB;

// SessionStore may be lazily created. Canonicalize the existing ancestor, retaining
// every missing suffix component; never exclude the ancestor itself more broadly.
async function canonicalExclusion(path: string): Promise<string> {
  if (path.length === 0 || path.length > 4096 || path.includes("\0")) throw new Error("unsupported runtime store exclusion path");
  let current = resolve(path); const suffix: string[] = [];
  for (let depth = 0; depth < 128; depth++) {
    try { return join(await realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      // A dangling link is not an absent ordinary suffix.
      try { await lstat(current); throw new Error("runtime store exclusion is a dangling link"); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
      suffix.unshift(basename(current)); current = dirname(current);
    }
  }
  throw new Error("runtime store exclusion exceeds 128 path components");
}

function bytes(repo: string, args: string[], signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: repo, env: gitEnvironment(), encoding: "buffer", maxBuffer: 16 * MIB, timeout: 60_000, signal },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && path.split("/").length <= 128 && path.split("/").every(part =>
    part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
    !/[\x00-\x1f\x7f\\:<>"|?*\ufffd]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
async function entries(repo: string, tree: string, signal: AbortSignal) {
  const output = (await git(repo, ["ls-tree", "-rz", tree], undefined, signal)).stdout;
  const rows = output.split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
    if (!match || !safePath(match[3]!)) throw new Error("isolated worktree requires supported regular-file paths; symlinks/submodules are not covered");
    return { mode: match[1]!, oid: match[2]!, path: match[3]! };
  });
  if (rows.length > 50_000) throw new Error("isolated worktree exceeds 50000 paths");
  const keys = rows.map(row => row.path.normalize("NFC").toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error("isolated worktree has case/normalization aliases");
  // Git may enumerate a directory junction as descendants rather than a link entry.
  // Refuse linked content ancestors too, independent of that enumeration shape.
  const checked = new Set<string>();
  for (const row of rows) {
    let parent = dirname(resolve(repo, row.path));
    while (parent !== repo && !checked.has(parent)) {
      signal.throwIfAborted();
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("isolated content has a linked or unsupported parent directory");
      checked.add(parent); parent = dirname(parent);
    }
  }
  return rows;
}
async function capacity(root: string, signal: AbortSignal): Promise<void> {
  const names = (await readdir(root)).filter(name => name !== "allocation.lock");
  if (names.length >= MAX_RETAINED) throw new Error("isolated worktree retention limit is 8; explicitly clean retained artifacts before retrying");
  let size = 0; let count = 0;
  const scan = async (path: string): Promise<void> => {
    signal.throwIfAborted();
    if (++count > 100_000) throw new Error("isolated retention inventory exceeds 100000 entries");
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("unsupported retained artifact type; operator inspection required");
    if (info.isDirectory()) { for (const name of await readdir(path)) await scan(join(path, name)); }
    else size += info.size;
    // Reserve one bounded snapshot and patch. Trusted child code can exceed its capture cap;
    // this admission check is not a filesystem quota or containment claim.
    if (size > MAX_BYTES - 136 * MIB) throw new Error("isolated retention capacity is 512 MiB including a 136 MiB admission reserve");
  };
  for (const name of names) await scan(join(root, name));
}

/** Retained candidate only: no automatic parent mutation or destructive cleanup. */
export async function prepareSubagentWorktree(ctx: ToolContext, excludes: string[]) {
  const repo = await realpath((await git(ctx.cwd, ["rev-parse", "--show-toplevel"], undefined, ctx.signal)).stdout.trim());
  if (await realpath(ctx.cwd) !== repo) throw new Error("isolated subagents require cwd at the Git worktree root");
  const canonicalExcludes = await Promise.all(excludes.map(canonicalExclusion));
  if (canonicalExcludes.some(path => inside(path, repo))) throw new Error("runtime store exclusion covers the repository root");
  const common = await realpath(resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"], undefined, ctx.signal)).stdout.trim()));
  // Git metadata is excluded structurally, without modifying ignore rules or user index.
  if (inside(repo, common) && common !== join(repo, ".git")) throw new Error("unsupported in-worktree Git metadata location");
  const root = join(common, "agentrig-isolated");
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("isolated artifact root must not be a symlink");
  const lock = join(root, "allocation.lock");
  await mkdir(lock); // No stale stealing; concurrent allocators fail explicitly.
  let artifact: string | undefined;
  let primaryError: Error | undefined;
  try {
    await capacity(root, ctx.signal);
    const capture = { point: "pre_tool" as const, sessionId: ctx.sessionId, cwd: repo, turn: 0, signal: ctx.signal, checkpointExcludes: canonicalExcludes };
    const baseline = await checkpointState(repo, capture);
    const files = await entries(repo, baseline.tree, ctx.signal);
    artifact = await mkdtemp(join(root, "child-"));
    const cwd = join(artifact, "worktree");
    const env = { ...gitEnvironment(), GIT_AUTHOR_NAME: "AgentRig", GIT_AUTHOR_EMAIL: "agentrig@localhost", GIT_COMMITTER_NAME: "AgentRig", GIT_COMMITTER_EMAIL: "agentrig@localhost" };
    const commit = (await git(repo, ["commit-tree", baseline.tree], env, ctx.signal, Buffer.from("isolated child baseline\n"))).stdout.trim();
    await git(repo, ["worktree", "add", "--detach", "--no-checkout", cwd, commit], undefined, ctx.signal);
    // Raw materialization avoids smudge filters, export attributes and CRLF transformations.
    let total = 0;
    for (const file of files) {
      const content = await bytes(repo, ["cat-file", "blob", file.oid], ctx.signal);
      total += content.length;
      if (total > 128 * MIB) throw new Error("isolated baseline exceeds 128 MiB");
      const target = join(cwd, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
    }
    await git(cwd, ["read-tree", commit], undefined, ctx.signal);
    if (!sameCheckpointState(baseline, await checkpointState(repo, capture))) throw new Error("parent changed during isolated worktree preparation");
    const initial = await checkpointState(cwd, { ...capture, cwd });
    if (initial.tree !== baseline.tree) throw new Error("isolated checkout differs from raw baseline");
    await writeFile(join(artifact, "baseline.json"), JSON.stringify({ version: 1, parentSession: ctx.sessionId, repo, cwd, baseline, commit }), { flag: "wx" });
    const retained = artifact;
    return { cwd, artifact: retained, async finish(childSession: string) {
      const state = await checkpointState(cwd, { ...capture, cwd });
      await entries(cwd, state.tree, ctx.signal);
      const patch = await bytes(repo, ["diff", "--binary", "--no-ext-diff", "--no-textconv", baseline.tree, state.tree, "--"], ctx.signal);
      if (patch.length > PATCH_BYTES) throw new Error("isolated patch exceeds 8 MiB; worktree retained");
      const changed = (await git(repo, ["diff", "--name-only", "-z", baseline.tree, state.tree, "--"], undefined, ctx.signal)).stdout.split("\0").filter(Boolean);
      const ready = sameCheckpointState(baseline, await checkpointState(repo, capture));
      const patchPath = join(retained, "candidate.patch");
      await writeFile(patchPath, patch, { flag: "wx" });
      const manifest = { version: 1, childSession, repo, cwd, baseline, resultTree: state.tree, changed, patchPath, ready,
        note: "Point-in-time candidate, not authorization or atomic apply. Parent must inspect and apply using separately authorized tools." };
      await writeFile(join(retained, "candidate.json"), JSON.stringify(manifest), { flag: "wx" });
      if (!ready) throw new Error(`parent changed; candidate is stale and must not be automatically applied; retained at ${retained}`);
      return manifest;
    } };
  } catch (error) {
    primaryError = new Error(`${error instanceof Error ? error.message : String(error)}${artifact ? `; retained at ${artifact}` : ""}`, { cause: error });
    throw primaryError;
  } finally {
    try { await rmdir(lock); }
    catch (error) {
      throw new Error(`${primaryError?.message ?? (artifact ? `worktree retained at ${artifact}` : "allocation failed")}; failed to release allocation lock ${lock}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: primaryError === undefined ? error : new AggregateError([primaryError, error]) });
    }
  }
}
