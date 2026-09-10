import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { Checkpointer, checkpointNamespaceForRepo, checkpointState, git, gitEnvironment, inside, sameCheckpointState } from "./checkpointer.js";
import { SessionStore, assertSessionId } from "./session-store.js";
import type { HookContext } from "./hooks.js";
import { sanitizeLine } from "./tools/skills.js";
import { checkpointNamespace } from "./checkpoint-refs.js";

interface Entry { path: string; mode: string; oid: string }

async function entries(repo: string, tree: string, signal: AbortSignal): Promise<Map<string, Entry>> {
  const result = new Map<string, Entry>();
  const raw = (await git(repo, ["ls-tree", "-rz", tree], undefined, signal)).stdout;
  for (const record of raw.split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("unsupported checkpoint tree entry");
    const [, mode, oid, path] = match as unknown as [string, string, string, string];
    if (path.includes("\ufffd") || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part.toLowerCase() === ".git") || !inside(repo, resolve(repo,path))) {
      throw new Error("unsafe checkpoint path");
    }
    result.set(path,{path,mode,oid});
  }
  if (result.size > 50_000) throw new Error("checkpoint exceeds path limit");
  return result;
}

async function blob(repo: string, oid: string, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolvePromise,reject) => {
    execFile("git",["--no-optional-locks","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","cat-file","blob",oid],{
      cwd:repo,encoding:"buffer",env:gitEnvironment(),signal,timeout:60_000,killSignal:"SIGKILL",maxBuffer:16*1024*1024,
    },(error,stdout)=>error ? reject(error) : resolvePromise(stdout));
  });
}

/** Walk without following a symlink parent, including parents that do not exist yet. */
async function parents(repo: string, path: string, create = false): Promise<void> {
  const parts = relative(repo,dirname(resolve(repo,path))).split(/[\\/]/).filter(Boolean);
  let current = repo;
  for (const part of parts) {
    current = join(current,part);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) continue;
      await mkdir(current);
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`undo parent is not an ordinary directory: ${current}`);
    if (!inside(repo,await realpath(current))) throw new Error("undo parent escapes repository");
  }
}

export interface UndoResult {
  restored: boolean;
  message: string;
  turn?: number;
  recovery?: string;
  auditId?: string;
}

/** Explicit destructive operation, with no force bypass. The caller must stop external writers. */
export async function undoSession(store: SessionStore, sessionId: string, options: {
  cwd?: string;
  toTurn?: number;
  signal?: AbortSignal;
  assertQuiescent?: (ctx: HookContext) => Promise<void>;
} = {}): Promise<UndoResult> {
  assertSessionId(sessionId);
  if (options.toTurn !== undefined && (!Number.isSafeInteger(options.toTurn) || options.toTurn <= 0)) throw new Error("--to-turn must be a positive integer");
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal,AbortSignal.timeout(60_000)]);
  const release = await store.acquireLock(sessionId);
  const checkpointer = new Checkpointer(options.assertQuiescent === undefined ? {} : {assertQuiescent:options.assertQuiescent});
  let recovery: string | undefined;
  let touched = false;
  try {
    const events = await store.readAll(sessionId);
    if (events.some(event=>event.sessionId!==sessionId)) throw new Error("session envelope mismatch");
    if (events.at(-1)?.type !== "session.end") throw new Error("undo requires a closed session with no active writer");
    const startIndex = events.map(event=>event.type==="session.start" || event.type==="session.resume").lastIndexOf(true);
    const run = events.slice(startIndex);
    const seal = run.filter(event=>event.type==="checkpoint.sealed").at(-1);
    if (!seal) {
      if (run.some(event=>event.type==="checkpoint.warning") && !run.some(event=>event.type==="checkpoint.created")) {
        return {restored:false,message:"undo skipped: checkpointing was unavailable outside Git"};
      }
      // Replay bounded recorded evidence, not a claim that refs still exist or restoration is safe.
      // At most 8 lines of <= 400 UTF-16 units (+ fixed truncation label): total < 4096 units.
      const lines: string[] = []; let omitted = 0;
      for (const event of run) {
        let line: string;
        if (event.type === "error" && event.message.startsWith("checkpoint seal failed:")) line = `recorded refusal: ${event.message}`;
        else if (event.type === "checkpoint.created") line = `recorded checkpoint (current retention not checked; not restorable without a seal): turn ${event.turn} at ${event.ref}`;
        else continue;
        if (lines.length === 8) { omitted++; continue; }
        const clean = sanitizeLine(line, 401);
        let prefix = "";
        for (const point of clean) { if (prefix.length + point.length > 400) break; prefix += point; }
        lines.push(prefix + (prefix.length < clean.length ? " [truncated]" : ""));
      }
      throw new Error(["undo unavailable: this run has no verified ownership seal (legacy, interrupted, or uncertain work)",
        ...lines,
        ...(omitted === 0 ? [] : [`omitted ${omitted} recorded entries; inspect the unchanged session log for complete evidence`]),
      ].join("\n"));
    }
    if (run.some(event=>event.seq>seal.seq && event.type!=="session.end" && event.type!=="error")) throw new Error("activity followed the ownership seal");
    const checkpoint = run.filter(event=>event.type==="checkpoint.created").filter(event=>options.toTurn===undefined || event.turn===options.toTurn).at(-1);
    if (!checkpoint) throw new Error("no checkpoint for that turn in the latest run; earlier resumed runs are not owned by this seal");
    const namespace = checkpointNamespace(checkpoint.ref, sessionId, checkpoint.turn);
    if (namespace === undefined || checkpointNamespace(seal.ref, sessionId, seal.turn, true) !== namespace) throw new Error("checkpoint namespace mismatch");
    const repo = await realpath((await git(options.cwd??process.cwd(),["rev-parse","--show-toplevel"],undefined,signal)).stdout.trim());
    if (repo !== await realpath(seal.repo) || repo===dirname(repo) || repo===await realpath(homedir())) throw new Error("undo repository does not match a safe recorded workspace");
    if (namespace !== "refs/agentrig" && namespace !== await checkpointNamespaceForRepo(repo, signal)) throw new Error("checkpoint worktree namespace mismatch");
    const storeRoot = await realpath(store.root);
    if (seal.excludes.length!==1 || seal.excludes[0]!==storeRoot || inside(storeRoot,repo)) throw new Error("session-store exclusion changed; refusing undo");
    const ctx: HookContext = {point:"pre_tool",sessionId,cwd:repo,turn:seal.turn,signal,checkpointExcludes:seal.excludes};
    await checkpointer.lease(repo,ctx);
    await checkpointer.guard(ctx);
    for (const event of [checkpoint,seal]) {
      const retained = (await git(repo,["for-each-ref","--format=%(refname)",event.ref],undefined,signal)).stdout.split("\n").includes(event.ref);
      if (!retained) throw new Error(`checkpoint turn ${event.turn} is unavailable (pruned or missing); only the last two mutating-turn refs are retained`);
      const symbolic = await git(repo,["symbolic-ref","-q",event.ref],undefined,signal).then(()=>true).catch(error=>{if(error.code===1)return false;throw error;});
      if (symbolic || (await git(repo,["rev-parse","--verify",event.ref],undefined,signal)).stdout.trim()!==event.commit ||
        (await git(repo,["rev-parse",`${event.commit}^{tree}`],undefined,signal)).stdout.trim()!==event.tree) throw new Error("checkpoint ref/object changed");
    }
    const parent = (await git(repo,["rev-list","--parents","-n","1",checkpoint.commit],undefined,signal)).stdout.trim().split(" ").slice(1);
    const expectedHead = seal.head.split("\n")[0];
    if (parent.length>1 || (parent[0]??"unborn")!==expectedHead) throw new Error("HEAD changed since the checkpoint; undo will not rewrite history");
    const verify = async () => {
      await checkpointer.guard(ctx);
      const actual = await checkpointState(repo,ctx);
      if (sameCheckpointState(seal,actual)) return;
      // Equality establishes current state only; a user or another tool may have restored it.
      if (actual.tree===checkpoint.tree && actual.head===seal.head && actual.indexHash===seal.indexHash) {
        throw new Error(`the worktree already matches turn ${checkpoint.turn}, so there is nothing to restore. `
          + "This observation does not establish who restored it; this undo changed nothing.");
      }
      throw new Error("non-session changes detected in worktree, HEAD, or index; undo refused");
    };
    await verify();
    const current = await entries(repo,seal.tree,signal);
    const target = await entries(repo,checkpoint.tree,signal);
    const changed = [...new Set([...current.keys(),...target.keys()])].filter(path=>current.get(path)?.oid!==target.get(path)?.oid || current.get(path)?.mode!==target.get(path)?.mode).sort();
    for (const path of changed) {
      if (seal.excludes.some(excluded=>inside(excluded,resolve(repo,path)))) throw new Error("undo would touch excluded session evidence");
      await parents(repo,path);
      const actual = await lstat(resolve(repo,path)).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
      // Order matters for the diagnostic, not the outcome: both refuse. A directory standing where
      // the checkpoint holds a file is a collision the operator has to resolve by hand, and
      // reporting it as an "ignored or unowned path" sends them to look at .gitignore instead.
      if (actual && !actual.isFile() && !actual.isSymbolicLink()) {
        throw new Error(`undo refuses non-file path: ${path}`
          + (actual.isDirectory() ? " — a directory now occupies a path the checkpoint holds as a file; resolve that collision by hand, nothing was restored" : ""));
      }
      if (actual && !current.has(path)) throw new Error(`undo would overwrite an ignored or unowned path: ${path}`);
    }
    // Git metadata is outside the captured tree. A cross-device rename refuses without truncation.
    const gitDir = await realpath(resolve(repo,(await git(repo,["rev-parse","--git-dir"],undefined,signal)).stdout.trim()));
    recovery = await mkdtemp(join(gitDir,"agentrig-undo-"));
    await chmod(recovery,0o700);
    await mkdir(join(recovery,"originals"));
    await mkdir(join(recovery,"staged"));
    await writeFile(join(recovery,"manifest.json"),JSON.stringify({repo,sessionId,checkpoint,seal,paths:changed},null,2),{flag:"wx"});
    let total = 0;
    for (const [n,path] of changed.entries()) {
      const entry = target.get(path);
      if (!entry) continue;
      const bytes = await blob(repo,entry.oid,signal);
      total += bytes.length;
      if (total>128*1024*1024) throw new Error("undo exceeds byte limit");
      const stage = join(recovery,"staged",String(n));
      if (entry.mode==="120000") await symlink(bytes,stage);
      else {
        await writeFile(stage,bytes,{flag:"wx",mode:entry.mode==="100755"?0o755:0o644});
        await chmod(stage,entry.mode==="100755"?0o755:0o644);
      }
    }
    await verify(); // staging and blob materialization grant no right to overwrite newer work
    for (const [n,path] of changed.entries()) {
      signal.throwIfAborted();
      await parents(repo,path,true);
      const full = resolve(repo,path);
      if (current.has(path)) {
        await rename(full,join(recovery,"originals",String(n)));
        touched = true;
      }
      const entry = target.get(path);
      if (entry) {
        const stage = join(recovery,"staged",String(n));
        if (entry.mode==="120000") await symlink(await blob(repo,entry.oid,signal),full);
        else await copyFile(stage,full,constants.COPYFILE_EXCL);
        touched = true;
      }
    }
    const restored = await checkpointState(repo,ctx);
    if (restored.tree!==checkpoint.tree || restored.head!==seal.head || restored.indexHash!==seal.indexHash) throw new Error("post-restore verification failed; stop writers and inspect recovery evidence");
    const auditId = store.create();
    await store.append(auditId,{type:"session.start",task:`Explicit undo of ${sessionId} to turn ${checkpoint.turn}`,cwd:repo,provider:"none",model:"none"});
    await store.append(auditId,{type:"checkpoint.restored",targetSession:sessionId,turn:checkpoint.turn,ref:checkpoint.ref,tree:checkpoint.tree,recovery});
    await store.append(auditId,{type:"session.end",reason:"done"});
    return {restored:true,turn:checkpoint.turn,recovery,auditId,message:`restored ${sessionId} to turn ${checkpoint.turn}; originals retained at ${recovery}; audit ${auditId}. Conversation history and index unchanged.`};
  } catch (error) {
    if (recovery) throw new Error(`${touched?"undo partially applied":"undo not applied"}; recovery retained at ${recovery}: ${String(error)}`);
    throw error;
  } finally {
    try { await checkpointer.endSession(sessionId); } finally { await release(); }
  }
}
