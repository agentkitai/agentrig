import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      env: env ?? process.env,
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

async function snapshot(ctx: HookContext): Promise<void> {
  if (ctx.emitCheckpoint === undefined) {
    throw new Error("Checkpointer must be run by an AgentRig agent");
  }

  let repo: string;
  try {
    repo = (await git(ctx.cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"], undefined, ctx.signal)).stdout.trim();
  } catch (error) {
    // A timeout abort is a checkpoint failure, not evidence that the directory is outside Git.
    // Propagate it so the dedicated fail-closed pass blocks the pending write.
    if (ctx.signal.aborted) throw error;
    await ctx.emitCheckpoint({
      type: "checkpoint.warning",
      message: `checkpointing disabled: ${ctx.cwd} is not inside a git repository`,
    });
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "agentrig-index-"));
  const index = join(dir, "index");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: index };
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
      if (event.type === "checkpoint.warning") {
        if (this.warned.has(ctx.sessionId)) return;
        this.warned.add(ctx.sessionId);
      }
      await originalEmit(event);
    };
    await snapshot({ ...ctx, emitCheckpoint: emitOnce });
  }
}

/** Internal loop discriminator: ordinary pre-tool hooks run before permission; this one runs after approval. */
export function isCheckpointerHook(hook: Hook): hook is Checkpointer {
  return CHECKPOINTER in hook;
}
