import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Hook, HookContext, HookResult } from "./hooks.js";

/** Events the built-in checkpointer may append through its deliberately narrow hook seam. */
export type CheckpointHookEvent =
  | { type: "checkpoint.created"; turn: number; ref: string; commit: string; tree: string }
  | { type: "checkpoint.warning"; message: string };

const CHECKPOINTER = Symbol("agentrig.checkpointer");

interface GitResult {
  stdout: string;
  stderr: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Repository-selection variables from the parent process must not redirect a checkpoint away
  // from the run cwd or make a healthy repository look absent. The private index is supplied only
  // to the plumbing calls that intentionally use it below.
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_NAMESPACE",
  ]) delete env[name];
  // Classification of the only fail-open case below relies on Git's stable English diagnostic.
  env.LC_ALL = "C";
  return env;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      // execFile drains both pipes; a larger explicit cap avoids false checkpoint failures in
      // repositories with unusually verbose diagnostics while retaining a bounded allocation.
      maxBuffer: 16 * 1024 * 1024,
      env: env ?? gitEnvironment(),
      ...(signal === undefined ? {} : { signal }),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isOutsideGit(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("stderr" in error)) return false;
  const { code, stderr } = error as { code?: unknown; stderr?: unknown };
  return code === 128 && typeof stderr === "string" && /not a git repository/i.test(stderr);
}

async function hasGitMetadata(cwd: string): Promise<boolean> {
  let current = await realpath(cwd);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function existingCheckpoint(
  repo: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ commit: string; tree: string } | undefined> {
  try {
    const symref = (await git(repo, ["symbolic-ref", "-q", ref], undefined, signal)).stdout.trim();
    throw new Error(`checkpoint ref ${ref} is symbolic (${symref}); refusing to overwrite it`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("checkpoint ref ")) throw error;
    if (signal.aborted) throw error;
    if (error === null || typeof error !== "object" || !("code" in error) || error.code !== 1) throw error;
  }

  const format = "%(refname)%00%(objectname)";
  const output = (await git(repo, ["for-each-ref", `--format=${format}`, ref], undefined, signal)).stdout;
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [foundRef, commit] = line.split("\0");
    if (foundRef !== ref) continue;
    if (commit === undefined || commit === "") throw new Error(`checkpoint ref ${ref} has no object`);
    const tree = (await git(repo, ["rev-parse", `${commit}^{tree}`], undefined, signal)).stdout.trim();
    return { commit, tree };
  }
  return undefined;
}

async function worktreeMatchesIndex(
  repo: string,
  pathspecs: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await git(repo, ["diff", "--quiet", "--ignore-submodules=all", "--", ...pathspecs], env, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error !== null && typeof error === "object" && "code" in error && error.code === 1) return false;
    throw error;
  }
  // Files created after `git add` are not in the index and therefore invisible to `git diff`.
  // `--directory` bounds output for whole untracked trees while still detecting their presence.
  const untracked = await git(
    repo,
    ["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "--", ...pathspecs],
    env,
    signal,
  );
  return untracked.stdout === "";
}

function snapshotPathspecs(repo: string, excludes: readonly string[] | undefined): string[] {
  const pathspecs = ["."];
  for (const excluded of excludes ?? []) {
    const rel = relative(repo, resolve(excluded));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
    const normalized = rel.replaceAll("\\", "/");
    pathspecs.push(normalized === "" ? ":(exclude,top)**" : `:(exclude,top)${normalized}`);
  }
  return pathspecs;
}

async function readParent(repo: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | undefined> {
  try {
    const parent = (await git(repo, ["rev-parse", "--verify", "HEAD"], undefined, signal)).stdout.trim();
    await git(repo, ["read-tree", parent], env, signal);
    return parent;
  } catch (error) {
    if (signal.aborted) throw error;
    // Only a genuinely unborn symbolic HEAD has no parent. Detached/corrupt HEAD and object-read
    // failures are checkpoint failures and must not silently become an empty snapshot.
    let target: string;
    try {
      target = (await git(repo, ["symbolic-ref", "-q", "HEAD"], undefined, signal)).stdout.trim();
    } catch {
      throw error;
    }
    const found = (await git(repo, ["for-each-ref", "--format=%(refname)", target], undefined, signal)).stdout.trim();
    if (found !== "") throw error;
    await git(repo, ["read-tree", "--empty"], env, signal);
    return undefined;
  }
}

async function snapshot(ctx: HookContext): Promise<void> {
  if (ctx.emitCheckpoint === undefined) {
    throw new Error("Checkpointer must be run by an AgentRig agent");
  }

  let repo: string;
  try {
    repo = (await git(ctx.cwd, ["rev-parse", "--show-toplevel"], undefined, ctx.signal)).stdout.trim();
  } catch (error) {
    // A timeout abort is a checkpoint failure, not evidence that the directory is outside Git.
    // Propagate it so the dedicated fail-closed pass blocks the pending write.
    if (ctx.signal.aborted || !isOutsideGit(error)) throw error;
    // Git uses the same "not a repository" diagnostic for a genuinely unversioned directory and
    // for broken linked-worktree metadata. Only the former may degrade; corrupt/inaccessible
    // metadata must block the write because there is a repository here that we failed to snapshot.
    if (await hasGitMetadata(ctx.cwd) || ctx.signal.aborted) throw error;
    await ctx.emitCheckpoint({
      type: "checkpoint.warning",
      message: `checkpointing disabled: ${ctx.cwd} is not inside a git repository`,
    });
    return;
  }

  const ref = `refs/agentrig/${ctx.sessionId}/${ctx.turn}`;
  const previous = await existingCheckpoint(repo, ref, ctx.signal);
  if (previous !== undefined) {
    await ctx.emitCheckpoint({ type: "checkpoint.created", turn: ctx.turn, ref, ...previous });
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "agentrig-index-"));
  const index = join(dir, "index");
  const env = gitEnvironment();
  env.GIT_INDEX_FILE = index;
  try {
    const parent = await readParent(repo, env, ctx.signal);
    const pathspecs = snapshotPathspecs(repo, ctx.checkpointExcludes);

    // `git add` reads the worktree into the throw-away index. It never updates the repository's
    // real index. `--sparse` ensures a sparse checkout does not omit dirty skip-worktree paths.
    // Verify the worktree still matches that private index so a file changing during the scan
    // cannot produce an internally inconsistent checkpoint; bounded retries fail closed on churn.
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        if (parent === undefined) await git(repo, ["read-tree", "--empty"], env, ctx.signal);
        else await git(repo, ["read-tree", parent], env, ctx.signal);
      }
      await git(repo, ["add", "--sparse", "-A", "--", ...pathspecs], env, ctx.signal);
      if (await worktreeMatchesIndex(repo, pathspecs, env, ctx.signal)) {
        stable = true;
        break;
      }
    }
    if (!stable) throw new Error("worktree changed while checkpointing; refusing an inconsistent snapshot");

    const tree = (await git(repo, ["write-tree"], env, ctx.signal)).stdout.trim();
    const commitArgs = ["commit-tree", tree, "-m", `AgentRig checkpoint ${ctx.sessionId} turn ${ctx.turn}`];
    if (parent !== undefined) commitArgs.push("-p", parent);
    const identity = {
      ...env,
      GIT_AUTHOR_NAME: "AgentRig Checkpointer",
      GIT_AUTHOR_EMAIL: "checkpointer@agentrig.invalid",
      GIT_COMMITTER_NAME: "AgentRig Checkpointer",
      GIT_COMMITTER_EMAIL: "checkpointer@agentrig.invalid",
    };
    const commit = (await git(repo, commitArgs, identity, ctx.signal)).stdout.trim();
    // Never dereference a hostile symbolic ref, and never replace a checkpoint another process won
    // the race to create. A later attempt will safely reuse the winner through existingCheckpoint.
    await git(repo, ["update-ref", "--no-deref", ref, commit, "0000000000000000000000000000000000000000"], undefined, ctx.signal);
    await ctx.emitCheckpoint({ type: "checkpoint.created", turn: ctx.turn, ref, commit, tree });
  } catch (error) {
    // Cleanup must not replace the primary Git/append error that explains why the write was blocked.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // A cleanup failure after a successful checkpoint still blocks the write and remains visible.
  await rm(dir, { recursive: true, force: true });
}

/**
 * A stateful `pre_tool` hook that snapshots once, immediately before the first allowed write-class
 * tool in each turn. Add an instance to `AgentConfig.hooks` to opt in.
 */
export class Checkpointer implements Hook {
  readonly point = "pre_tool" as const;
  readonly id = "core:checkpointer";
  readonly timeoutMs: number;
  readonly [CHECKPOINTER] = true;
  private readonly attempts = new Map<string, { turn: number; work: Promise<void> }>();

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  private readonly warned = new Set<string>();

  /** Release state retained only to coordinate calls within one active session. */
  endSession(sessionId: string): void {
    this.attempts.delete(sessionId);
    this.warned.delete(sessionId);
  }

  async handler(ctx: HookContext): Promise<HookResult> {
    if (ctx.permission !== "write") return { action: "continue" };
    let entry = this.attempts.get(ctx.sessionId);
    if (entry?.turn !== ctx.turn) {
      entry = { turn: ctx.turn, work: this.create(ctx) };
      this.attempts.set(ctx.sessionId, entry);
    }
    try {
      await entry.work;
    } catch (error) {
      if (this.attempts.get(ctx.sessionId) === entry) this.attempts.delete(ctx.sessionId);
      throw error;
    }
    return { action: "continue" };
  }

  private async create(ctx: HookContext): Promise<void> {
    const originalEmit = ctx.emitCheckpoint;
    if (originalEmit === undefined) return snapshot(ctx);
    const emitOnce = async (event: CheckpointHookEvent): Promise<void> => {
      if (event.type === "checkpoint.warning" && this.warned.has(ctx.sessionId)) return;
      await originalEmit(event);
      // Suppress only warnings that reached the immutable log. If append failed, the checkpoint
      // attempt must reject and a later write must retry rather than treating a lost warning as success.
      if (event.type === "checkpoint.warning") this.warned.add(ctx.sessionId);
    };
    await snapshot({ ...ctx, emitCheckpoint: emitOnce });
  }
}

/** Internal loop discriminator: ordinary pre-tool hooks run before permission; this one runs after approval. */
export function isCheckpointerHook(hook: Hook): hook is Checkpointer {
  return CHECKPOINTER in hook;
}
