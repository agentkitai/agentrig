import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  const dir = await mkdtemp(join(tmpdir(), "agentrig-index-"));
  const index = join(dir, "index");
  const env = gitEnvironment();
  env.GIT_INDEX_FILE = index;
  try {
    let parent: string | undefined;
    try {
      parent = (await git(repo, ["rev-parse", "--verify", "HEAD"], undefined, ctx.signal)).stdout.trim();
      await git(repo, ["read-tree", parent], env, ctx.signal);
    } catch {
      await git(repo, ["read-tree", "--empty"], env, ctx.signal);
    }

    // `git add` reads the worktree into the throw-away index. It never updates the repository's
    // real index, and the following plumbing commands write objects/our private ref only.
    await git(repo, ["add", "-A", "--", "."], env, ctx.signal);
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
    const ref = `refs/agentrig/${ctx.sessionId}/${ctx.turn}`;
    await git(repo, ["update-ref", ref, commit], undefined, ctx.signal);
    await ctx.emitCheckpoint({ type: "checkpoint.created", turn: ctx.turn, ref, commit, tree });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A stateful `pre_tool` hook that snapshots once, immediately before the first allowed write-class
 * tool in each turn. Add an instance to `AgentConfig.hooks` to opt in.
 */
export class Checkpointer implements Hook {
  readonly point = "pre_tool" as const;
  readonly id = "core:checkpointer";
  readonly [CHECKPOINTER] = true;
  private readonly attempts = new Map<string, { turn: number; work: Promise<void> }>();
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
