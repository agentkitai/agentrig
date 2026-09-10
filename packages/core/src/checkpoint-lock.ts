import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const Owner = z.object({ version: z.literal(1), nonce: z.string().uuid(), pid: z.number().int().positive().safe(),
  host: z.string().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value)), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  repo: z.string().min(1).max(4096), commonDir: z.string().min(1).max(4096), createdAt: z.number().int().nonnegative().safe(),
}).strict();
type Owner = z.infer<typeof Owner>;
export interface CheckpointLockInspection {
  path: string;
  state: "missing" | "legacy-empty" | "live-owner" | "dead-owner" | "unknown-owner";
  /** Observation identity, never permission or proof of quiescence. */
  token?: string;
  owner?: Readonly<Owner>;
}
export interface CheckpointRecoveryOptions {
  expectedToken: string;
  confirmQuiescent: boolean;
  acknowledgeLegacyEmpty?: boolean;
  signal?: AbortSignal;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (stat: Awaited<ReturnType<typeof lstat>>) => [String(stat.dev), String(stat.ino), String(stat.birthtimeMs), String(stat.ctimeMs), String(stat.mtimeMs)];
const problem = (path: string, reason: string) => new Error(`checkpoint lock ${JSON.stringify(path)}: ${reason}; stop all repository/worktree writers before explicit recovery`);

/** Internal path is derived from canonical Git common-dir, never accepted from owner metadata. */
async function readLock(path: string, commonDir = dirname(path)) {
  if (await realpath(dirname(path)) !== dirname(path)) throw problem(path, "common directory changed");
  let directory;
  try { directory = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw problem(path, "expected a regular lock directory, not a symlink");
  const names: string[] = [];
  for await (const entry of await opendir(path)) { names.push(entry.name); if (names.length === 2) break; }
  if (names.length > 1 || (names.length === 1 && names[0] !== "owner.json")) throw problem(path, "unknown contents retained");
  let owner: Owner | undefined; let ownerIdentity: string[] | undefined; let bytes = "";
  if (names.length) {
    const ownerPath = join(path, "owner.json"); const before = await lstat(ownerPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw problem(path, "unsafe or oversized owner metadata retained");
    const file = await open(ownerPath, "r");
    try {
      const actual = await file.stat();
      if (JSON.stringify(identity(before)) !== JSON.stringify(identity(actual))) throw problem(path, "owner changed while opening");
      const buffer = Buffer.alloc(4097); let offset = 0;
      while (offset < buffer.length) { const read = await file.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset > 4096) throw problem(path, "owner metadata exceeds 4096 bytes");
      try { bytes = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)); owner = Owner.parse(JSON.parse(bytes)); }
      catch { throw problem(path, "malformed owner metadata retained"); }
      const after = await file.stat(); const named = await lstat(ownerPath);
      if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after)) || JSON.stringify(identity(before)) !== JSON.stringify(identity(named))) throw problem(path, "owner changed while reading");
      ownerIdentity = identity(after);
    } finally { await file.close(); }
    if (owner.commonDir !== commonDir) throw problem(path, "owner common-directory identity mismatch");
  }
  const after = await lstat(path);
  if (JSON.stringify(identity(directory)) !== JSON.stringify(identity(after))) throw problem(path, "directory changed while inspecting");
  return { directory, owner, contents: digest(JSON.stringify({ ownerIdentity, bytes })), token: digest(JSON.stringify({ directory: identity(directory), ownerIdentity, bytes })) };
}
function ownerState(owner: Owner): CheckpointLockInspection["state"] {
  if (owner.host !== hostname()) return "unknown-owner";
  try { process.kill(owner.pid, 0); return "live-owner"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead-owner" : "unknown-owner"; }
}
export async function inspectLockPath(path: string): Promise<CheckpointLockInspection> {
  const lock = await readLock(path);
  if (lock === null) return { path, state: "missing" };
  return { path, token: lock.token, state: lock.owner === undefined ? "legacy-empty" : ownerState(lock.owner),
    ...(lock.owner === undefined ? {} : { owner: Object.freeze({ ...lock.owner }) }) };
}
export async function acquireCheckpointLock(path: string, repo: string, sessionId: string): Promise<string> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let details = "unrecognized ownership";
    try { const seen = await inspectLockPath(path); details = `${seen.state}${seen.owner ? ` (pid ${seen.owner.pid}, session ${JSON.stringify(seen.owner.sessionId)})` : ""}`; } catch { /* preserve fixed safe refusal */ }
    throw new Error(`checkpoint ownership uncertain: another session or retained lock exists at ${JSON.stringify(path)}; ${details}; inspect with checkpoints lock inspect, then stop writers before explicit recovery`);
  }
  const owner = Owner.parse({ version: 1, nonce: randomUUID(), pid: process.pid, host: hostname(), sessionId,
    repo, commonDir: dirname(path), createdAt: Date.now() });
  const bytes = JSON.stringify(owner) + "\n";
  if (Buffer.byteLength(bytes) > 4096) throw problem(path, "owner metadata exceeds 4096 bytes; new lock retained");
  const file = await open(join(path, "owner.json"), "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return (await readLock(path))!.token;
}
export async function assertCheckpointLock(path: string, token: string): Promise<void> {
  try { if ((await readLock(path))?.token === token) return; } catch { /* unsafe replacement is not ours to clean */ }
  throw problem(path, "checkpoint lease replaced or owner metadata changed; refusing cleanup/mutation");
}
export async function releaseCheckpointLock(path: string, token: string): Promise<void> {
  await assertCheckpointLock(path, token);
  const before = await lstat(path);
  await unlink(join(path, "owner.json"));
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs || !after.isDirectory()) throw problem(path, "checkpoint lease replaced during cleanup");
  await rmdir(path); // Refuse unexpected content, never recursively remove it.
}
export async function recoverLockPath(path: string, options: CheckpointRecoveryOptions): Promise<{ path: string; preservedAt: string }> {
  if (options.confirmQuiescent !== true) throw problem(path, "explicit stopped-writers acknowledgment required");
  if (typeof options.expectedToken !== "string" || !/^[a-f0-9]{64}$/.test(options.expectedToken)) throw problem(path, "exact inspection token required");
  options.signal?.throwIfAborted();
  const check = async () => {
    const seen = await inspectLockPath(path);
    if (seen.token !== options.expectedToken) throw problem(path, "inspection identity changed or lock missing");
    if (seen.state === "legacy-empty") {
      if (options.acknowledgeLegacyEmpty !== true) throw problem(path, "legacy empty owner is unknown; explicit legacy acknowledgment required");
    } else if (seen.state !== "dead-owner") throw problem(path, `${seen.state}; owner death not established`);
    return seen;
  };
  await check();
  // Create-only recovery container; never overwrite another recovery or delete its evidence.
  const container = await mkdtemp(join(dirname(path), "agentrig-checkpoint-recovery-"));
  const preservedAt = join(container, "lock");
  await check(); options.signal?.throwIfAborted();
  const before = await readLock(path);
  if (before?.token !== options.expectedToken) throw problem(path, "inspection identity changed before recovery");
  await rename(path, preservedAt);
  // A rename can change ctime, so verify invariant identities via the original token before
  // moving and inspect retained contents afterward. External writers must remain stopped.
  const after = await readLock(preservedAt, dirname(path));
  if (after === null || before.directory.dev !== after.directory.dev || before.directory.ino !== after.directory.ino
    || before.directory.birthtimeMs !== after.directory.birthtimeMs || before.contents !== after.contents)
    throw problem(path, `recovery uncertain; inspect ${JSON.stringify(preservedAt)}`);
  return { path, preservedAt };
}
