import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Hook, HookContext, HookResult } from "./hooks.js";
import { assertSessionId } from "./session-store.js";

/** Events the built-in checkpointer may append through its deliberately narrow hook seam. */
export type CheckpointHookEvent =
  | { type: "checkpoint.created"; turn: number; ref: string; commit: string; tree: string }
  | ({ type: "checkpoint.sealed"; turn: number; ref: string; commit: string; repo: string; excludes: string[] } & CheckpointState)
  | { type: "checkpoint.warning"; message: string };

export interface CheckpointState { tree: string; head: string; indexHash: string }

const CHECKPOINTER = Symbol("agentrig.checkpointer");

interface GitResult {
  stdout: string;
  stderr: string;
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Repository-selection variables from the parent process must not redirect a checkpoint away
  // from the run cwd or make a healthy repository look absent. The private index is supplied only
  // to the plumbing calls that intentionally use it below.
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  env.GIT_NO_REPLACE_OBJECTS = "1";
  // Classification of the only fail-open case below relies on Git's stable English diagnostic.
  env.LC_ALL = "C";
  return env;
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal, input?: Buffer): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      // execFile drains both pipes; a larger explicit cap avoids false checkpoint failures in
      // repositories with unusually verbose diagnostics while retaining a bounded allocation.
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: env ?? gitEnvironment(),
      ...(signal === undefined ? {} : { signal }),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.on("error", () => {}); // the command callback reports early process failures
    child.stdin?.end(input);
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

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

/** Raw worktree bytes, not clean filters / CRLF normalization. The real index only supplies
 * tracked path names, never the captured contents. Ignored untracked files are out of scope. */
async function captureTree(repo: string, parent: string | undefined, env: NodeJS.ProcessEnv, ctx: HookContext): Promise<string> {
  const signal = ctx.signal;
  const cached = (await git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], undefined, signal)).stdout;
  const head = parent === undefined ? "" : (await git(repo, ["ls-tree", "-rz", "--name-only", parent], undefined, signal)).stdout;
  const paths = [...new Set((cached + head).split("\0").filter(Boolean))].sort();
  if (paths.length > 50_000) throw new Error("checkpoint exceeds 50000 paths");
  await git(repo, ["read-tree", "--empty"], env, signal);
  let total = 0;
  const records: string[] = [];
  for (const path of paths) {
    signal.throwIfAborted();
    if (path.includes("\ufffd") || !inside(repo, resolve(repo, path))) throw new Error("unsupported checkpoint path encoding/location");
    const full = resolve(repo, path);
    if ((ctx.checkpointExcludes ?? []).some(excluded => inside(resolve(excluded), full))) continue;
    let stat;
    try { stat = await lstat(full); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!inside(repo, await realpath(dirname(full)))) throw new Error("checkpoint parent escapes repository");
    if (stat.isDirectory()) throw new Error("checkpoint cannot cover nested repositories/submodules");
    let bytes: Buffer;
    if (stat.isSymbolicLink()) bytes = await readlink(full, { encoding: "buffer" });
    else {
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("checkpoint requires regular files of at most 16 MiB");
      const file = await open(full, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error("checkpoint file changed type/size");
        bytes = Buffer.alloc(before.size + 1);
        let n = 0;
        while (n < bytes.length) { const got = await file.read(bytes, n, bytes.length - n, n); if (!got.bytesRead) break; n += got.bytesRead; }
        const after = await file.stat();
        if (n !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("worktree changed while checkpointing");
        bytes = bytes.subarray(0, n);
      } finally { await file.close(); }
    }
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error("checkpoint exceeds 128 MiB");
    const oid = (await git(repo, ["hash-object", "-w", "--stdin", "--no-filters"], env, signal, bytes)).stdout.trim();
    const mode = stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    records.push(`${mode} ${oid}\t${path}\0`);
  }
  await git(repo, ["update-index", "-z", "--index-info"], env, signal, Buffer.from(records.join("")));
  return (await git(repo, ["write-tree"], env, signal)).stdout.trim();
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

/** Compare both raw covered bytes and Git state; a clean `git status` is not ownership evidence. */
export async function checkpointState(repo: string, ctx: HookContext): Promise<CheckpointState> {
  const dir = await mkdtemp(join(tmpdir(), "agentrig-state-"));
  try {
    const env = {...gitEnvironment(), GIT_INDEX_FILE: join(dir,"index")};
    const metadata = async () => {
      const parent = await readParent(repo, env, ctx.signal);
      const branch = await git(repo, ["symbolic-ref", "-q", "HEAD"], undefined, ctx.signal).catch(error => {
        if (error.code === 1) return {stdout:"",stderr:""}; throw error;
      });
      const indexPath = resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"], undefined, ctx.signal)).stdout.trim());
      const index = await open(indexPath,constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)).catch(error => {
        if (error.code === "ENOENT") return undefined; throw error;
      });
      let bytes = Buffer.alloc(0);
      if (index) try {
        const stat = await index.stat();
        if (!stat.isFile() || stat.size > 16*1024*1024) throw new Error("undo ownership requires a regular index of at most 16 MiB");
        bytes = Buffer.alloc(stat.size+1);
        let n=0;
        while(n<bytes.length) { const got=await index.read(bytes,n,bytes.length-n,n); if(!got.bytesRead)break; n+=got.bytesRead; }
        const after=await index.stat();
        if(n!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs) throw new Error("index changed while verifying ownership");
        bytes=bytes.subarray(0,n);
      } finally { await index.close(); }
      return {parent,head:`${parent??"unborn"}\n${branch.stdout.trim()}`,indexHash:createHash("sha256").update(bytes).digest("hex")};
    };
    const before = await metadata();
    const tree = await captureTree(repo,before.parent,env,ctx);
    if (tree !== await captureTree(repo,before.parent,env,ctx)) throw new Error("worktree changed while verifying ownership");
    const after = await metadata();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Git state changed while verifying ownership");
    return {tree,head:before.head,indexHash:before.indexHash};
  } finally { await rm(dir,{recursive:true,force:true}); }
}

export function sameCheckpointState(a: CheckpointState, b: CheckpointState): boolean {
  return a.tree === b.tree && a.head === b.head && a.indexHash === b.indexHash;
}

async function snapshot(ctx: HookContext, checkpointer: Checkpointer): Promise<void> {
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

  repo = await realpath(repo);
  if ((ctx.checkpointExcludes ?? []).some(path => inside(resolve(path), repo))) throw new Error("checkpoint store exclusion covers the repository root");
  await checkpointer.guard(ctx);
  const sparse = await git(repo, ["config", "--bool", "core.sparseCheckout"], undefined, ctx.signal).catch(error => {
    if (error.code === 1) return { stdout: "false", stderr: "" }; throw error;
  });
  if (sparse.stdout.trim() === "true") throw new Error("checkpoint does not support sparse checkouts");
  await checkpointer.lease(repo, ctx);
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
    const tree = await captureTree(repo, parent, env, ctx);
    await checkpointer.guard(ctx);
    if (tree !== await captureTree(repo, parent, env, ctx)) throw new Error("worktree changed while checkpointing; refusing an inconsistent snapshot");
    await checkpointer.guard(ctx);
    const parentNow = await readParent(repo, env, ctx.signal);
    if (parentNow !== parent) throw new Error("HEAD changed while checkpointing");
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
    await git(repo, ["update-ref", "--no-deref", ref, commit, "0".repeat(commit.length)], undefined, ctx.signal);
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
 * A stateful `pre_tool` hook that snapshots once, immediately before the first potentially mutating
 * tool in each turn. Add an instance to `AgentConfig.hooks` to opt in.
 */
export class Checkpointer implements Hook {
  readonly point = "pre_tool" as const;
  readonly id = "core:checkpointer";
  readonly timeoutMs: number;
  readonly [CHECKPOINTER] = true;
  private readonly attempts = new Map<string, { turn: number; work: Promise<void> }>();
  private readonly leases = new Map<string, { path: string; repo: string; ino: number; dev: number }>();
  private readonly assertQuiescent: ((ctx: HookContext) => Promise<void>) | undefined;
  private readonly owned = new Map<string, CheckpointState>();
  private readonly uncertain = new Set<string>();

  constructor(options: { timeoutMs?: number; assertQuiescent?: (ctx: HookContext) => Promise<void> } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) throw new Error("checkpoint timeout must be in (0, 60000]");
    this.assertQuiescent = options.assertQuiescent;
  }
  private readonly warned = new Set<string>();

  /** Release state retained only to coordinate calls within one active session. */
  async endSession(sessionId: string): Promise<void> {
    await this.attempts.get(sessionId)?.work.catch(() => {});
    this.attempts.delete(sessionId);
    this.warned.delete(sessionId);
    this.owned.delete(sessionId);
    this.uncertain.delete(sessionId);
    const lease = this.leases.get(sessionId);
    if (lease !== undefined) {
      const current = await lstat(lease.path);
      if (!current.isDirectory() || current.ino !== lease.ino || current.dev !== lease.dev) throw new Error("checkpoint lease replaced; refusing cleanup");
      await rmdir(lease.path); // never recursively remove contents we did not create
      this.leases.delete(sessionId);
    }
  }

  /** Hosts must keep unregistered external/background writers stopped. This callback can reject
   * known external uncertainty; Git scans cannot prove the absence of arbitrary future writes. */
  async guard(ctx: HookContext): Promise<void> {
    ctx.signal.throwIfAborted();
    if (ctx.toolEffect === "background" || ctx.hasBackgroundWork?.()) throw new Error("checkpoint ownership uncertain: background work must stop before mutation");
    const lease = this.leases.get(ctx.sessionId);
    if (lease) {
      const current = await lstat(lease.path);
      if (!current.isDirectory() || current.ino !== lease.ino || current.dev !== lease.dev) throw new Error("checkpoint lease replaced");
    }
    if (this.assertQuiescent) {
      let abort: () => void = () => {};
      try {
        await Promise.race([this.assertQuiescent(ctx), new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("checkpoint quiescence check aborted"));
          if (ctx.signal.aborted) abort(); else ctx.signal.addEventListener("abort", abort, { once: true });
        })]);
      } finally { ctx.signal.removeEventListener("abort", abort); }
    }
    ctx.signal.throwIfAborted();
  }

  async lease(repo: string, ctx: HookContext): Promise<void> {
    const common = (await git(repo, ["rev-parse", "--git-common-dir"], undefined, ctx.signal)).stdout.trim();
    const path = join(await realpath(resolve(repo, common)), "agentrig-checkpoint.lock");
    const existing = this.leases.get(ctx.sessionId);
    if (existing?.path === path && existing.repo === repo) return;
    if (existing !== undefined) throw new Error("checkpoint session changed repositories");
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("checkpoint ownership uncertain: another session or retained lock exists; stop writers before manual recovery");
      throw error;
    }
    const stat = await lstat(path);
    this.leases.set(ctx.sessionId, { path, repo, ino: stat.ino, dev: stat.dev });
    ctx.signal.throwIfAborted();
  }

  async handler(ctx: HookContext): Promise<HookResult> {
    assertSessionId(ctx.sessionId);
    if (!Number.isSafeInteger(ctx.turn) || ctx.turn <= 0) throw new Error("invalid checkpoint turn");
    if (ctx.toolEffect === "read-only") return { action: "continue" };
    if (this.uncertain.has(ctx.sessionId)) throw new Error("checkpoint ownership uncertain; stop this session before further mutation");
    if (this.leases.has(ctx.sessionId)) await this.guard(ctx);
    const owned = this.owned.get(ctx.sessionId);
    if (owned) {
      const actual = await checkpointState(this.leases.get(ctx.sessionId)!.repo,ctx);
      if (!sameCheckpointState(owned,actual)) {
        this.uncertain.add(ctx.sessionId);
        throw new Error("non-session changes detected; refusing mutation and undo ownership");
      }
    }
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

  /** Called only after a mutating invocation settles; abort races cannot certify late writers. */
  async afterTool(ctx: HookContext): Promise<void> {
    if (ctx.toolEffect === "read-only" || !this.leases.has(ctx.sessionId)) return;
    this.uncertain.add(ctx.sessionId);
    await this.guard(ctx);
    const state = await checkpointState(this.leases.get(ctx.sessionId)!.repo,ctx);
    await this.guard(ctx);
    this.owned.set(ctx.sessionId,state);
    this.uncertain.delete(ctx.sessionId);
  }

  /** Persist a stable terminal receipt, never silently adopt edits after the final tool. */
  async seal(ctx: HookContext): Promise<void> {
    if (this.uncertain.has(ctx.sessionId)) throw new Error("undo unavailable: checkpoint ownership uncertain");
    const owned = this.owned.get(ctx.sessionId);
    const lease = this.leases.get(ctx.sessionId);
    if (!owned || !lease) return;
    await this.guard(ctx);
    const current = await checkpointState(lease.repo,ctx);
    if (!sameCheckpointState(owned,current)) throw new Error("undo unavailable: non-session changes after the final tool");
    const ref = `refs/agentrig/${ctx.sessionId}/sealed/${ctx.turn}`;
    const env = {...gitEnvironment(),GIT_AUTHOR_NAME:"AgentRig",GIT_AUTHOR_EMAIL:"checkpoint@agentrig.invalid",GIT_COMMITTER_NAME:"AgentRig",GIT_COMMITTER_EMAIL:"checkpoint@agentrig.invalid"};
    const commit = (await git(lease.repo,["commit-tree",owned.tree,"-m",`AgentRig ownership ${ctx.sessionId}`],env,ctx.signal)).stdout.trim();
    await git(lease.repo,["update-ref","--no-deref",ref,commit,"0".repeat(commit.length)],undefined,ctx.signal);
    await ctx.emitCheckpoint?.({type:"checkpoint.sealed",turn:ctx.turn,ref,commit,repo:lease.repo,excludes:ctx.checkpointExcludes??[],...owned});
  }

  private async create(ctx: HookContext): Promise<void> {
    const originalEmit = ctx.emitCheckpoint;
    if (originalEmit === undefined) return snapshot(ctx, this);
    const emitOnce = async (event: CheckpointHookEvent): Promise<void> => {
      if (event.type === "checkpoint.warning" && this.warned.has(ctx.sessionId)) return;
      await originalEmit(event);
      // Suppress only warnings that reached the immutable log. If append failed, the checkpoint
      // attempt must reject and a later write must retry rather than treating a lost warning as success.
      if (event.type === "checkpoint.warning") this.warned.add(ctx.sessionId);
    };
    await snapshot({ ...ctx, emitCheckpoint: emitOnce }, this);
  }
}

/** Internal loop discriminator: ordinary pre-tool hooks run before permission; this one runs after approval. */
export function isCheckpointerHook(hook: Hook): hook is Checkpointer {
  return CHECKPOINTER in hook;
}
