import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { withMemoryLock, type MemoryLockOptions } from "../lock.js";
import { readBoundedFile } from "../bounded-file.js";
import { ScanBudget, walkTree, type ScanOptions } from "../scan.js";

export interface DreamFileOptions extends MemoryLockOptions, ScanOptions {}

export interface DreamWorkspace {
  outputRoot: string;
  /** Saved beside the copy; survives process exit and is required for apply. */
  manifestPath: string;
  /** Refuses a replaced directory/manifest or an active/stale writer lock. Idempotent. */
  dispose(): Promise<void>;
}

const Identity = z.object({ dev: z.string(), ino: z.string(), birthtimeNs: z.string() }).strict();
const Manifest = z.object({
  version: z.literal(1),
  owner: z.string().uuid(),
  sourceRoot: z.string(),
  sourceIdentity: Identity,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  outputRoot: z.string(),
  outputIdentity: Identity,
}).strict();
type Manifest = z.infer<typeof Manifest>;
const manifestPath = (root: string) => root + ".dream.json";
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("dream root must be a real directory: " + path);
  return { dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
};
const sameIdentity = (a: z.infer<typeof Identity>, b: z.infer<typeof Identity>) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Resolve through the nearest existing ancestor, including aliases of an absent destination. */
async function physical(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await physical(parent), basename(absolute));
  }
}

function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
  };
  return inside(a, b) || inside(b, a);
}

/** Canonical ordering prevents two multi-root operations from taking inverse lock orders. */
async function locked<T>(roots: string[], work: () => Promise<T>, opts: MemoryLockOptions): Promise<T> {
  const ordered = [...new Set(roots)].sort();
  const enter = (n: number): Promise<T> => n === ordered.length ? work() : withMemoryLock(ordered[n]!, () => enter(n + 1), opts);
  return enter(0);
}

async function readManifest(out: string, opts: MemoryLockOptions = {}): Promise<Manifest> {
  const path = manifestPath(out);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid dream workspace manifest: " + path);
  return Manifest.parse(JSON.parse((await readBoundedFile(path, opts.maxFileBytes ?? 65536, opts.signal)).toString("utf8")));
}

async function verifyOutput(out: string, manifest: Manifest): Promise<void> {
  if (manifest.outputRoot !== out || !sameIdentity(await identity(out), manifest.outputIdentity)) {
    throw new Error("dream workspace was replaced; refusing to touch " + out);
  }
}

async function removeOwnedDirectory(path: string, expected: z.infer<typeof Identity>): Promise<void> {
  if (!(await exists(path))) return;
  if (!sameIdentity(await identity(path), expected)) throw new Error("dream directory ownership changed; preserving " + path);
  await rm(path, { recursive: true });
}

/** Bounded reads and exclusive writes into an already-owned empty root. Never delegate an
 * unbounded recursive copy after checking only a possibly stale pre-scan. */
async function copyContents(source: string, destination: string, opts: ScanOptions): Promise<void> {
  const budget = new ScanBudget(opts);
  await walkTree(source, budget, {
    entry: async entry => {
      budget.check(); const target = join(destination, entry.relative);
      if (entry.kind === "directory") await mkdir(target, { mode: 0o700 });
      else {
        await writeFile(target, entry.bytes!, { flag: "wx", mode: entry.targetMode,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }) });
        budget.check(); await chmod(target, entry.targetMode); // preserve bits masked by umask
      }
      budget.check();
    },
    leaveDirectory: async entry => { budget.check(); await chmod(join(destination, entry.relative), entry.targetMode); },
  });
  budget.check();
  await chmod(destination, (await stat(source)).mode & 0o777);
}

function workspace(manifest: Manifest): DreamWorkspace {
  const out = manifest.outputRoot;
  return {
    outputRoot: out,
    manifestPath: manifestPath(out),
    dispose: async () => {
      // Do not resolve a replacement symlink and lock/delete its unrelated target.
      if (!(await exists(out)) && !(await exists(manifestPath(out)))) return;
      if (await exists(out)) await verifyOutput(out, manifest);
      await withMemoryLock(out, async () => {
        const current = await readManifest(out);
        if (current.owner !== manifest.owner) throw new Error("dream manifest owner changed; preserving " + manifestPath(out));
        if (await exists(out)) {
          await verifyOutput(out, manifest);
          await removeOwnedDirectory(out, manifest.outputIdentity);
        }
        await rm(manifestPath(out));
      });
    },
  };
}

/** Fresh, owned copy plus a persisted source snapshot. No model work holds these locks.
 * Symlinks are materialized in the copy; the source fingerprint includes their targets.
 */
export async function copyWiki(sourceRoot: string, destRoot?: string, opts: DreamFileOptions = {}): Promise<DreamWorkspace> {
  new ScanBudget(opts); // Validate before creating an owned directory.
  opts.signal?.throwIfAborted();
  const src = await realpath(sourceRoot);
  const sourceIdentity = await identity(src);
  let out: string;
  let precreated: z.infer<typeof Identity> | undefined;
  if (destRoot === undefined) {
    out = await mkdtemp(join(tmpdir(), "agentrig-dream-"));
    out = await realpath(out);
    precreated = await identity(out);
  } else {
    out = await physical(destRoot);
    if (overlaps(src, out)) throw new Error("copyWiki: source and output overlap; the dream must write to a fresh copy");
    if (await exists(out)) throw new Error("copyWiki: output already exists; refusing to overwrite " + out);
    await mkdir(dirname(out), { recursive: true });
  }
  if (overlaps(src, out)) throw new Error("copyWiki: source and output overlap; the dream must write to a fresh copy");
  let owned = precreated;
  let ownedManifest: { dev: bigint; ino: bigint; birthtimeNs: bigint } | undefined;
  try {
    return await locked([src, out], async () => {
      if (!sameIdentity(await identity(src), sourceIdentity)) throw new Error("dream source root changed before snapshot");
      if (precreated === undefined) { await mkdir(out); owned = await identity(out); }
      else if (!sameIdentity(await identity(out), precreated)) throw new Error("dream output root was replaced before copy");
      if (await exists(manifestPath(out))) throw new Error("dream manifest already exists; preserving " + manifestPath(out));
      const before = await fingerprint(src, opts);
      await copyContents(src, out, opts);
      opts.signal?.throwIfAborted();
      if (await fingerprint(src, opts) !== before) throw new Error("dream source changed while copying; retry from a fresh snapshot");
      const manifest: Manifest = {
        version: 1, owner: randomUUID(), sourceRoot: src, sourceIdentity,
        sourceFingerprint: before, outputRoot: out, outputIdentity: owned!,
      };
      const handle = await open(manifestPath(out), "wx", 0o600);
      try {
        ownedManifest = await handle.stat({ bigint: true });
        await handle.writeFile(JSON.stringify(manifest) + "\n", "utf8");
      } finally { await handle.close(); }
      opts.signal?.throwIfAborted();
      return workspace(manifest);
    }, opts);
  } catch (error) {
    // Only our just-created directory is eligible for cleanup. Never an existing destination.
    if (owned !== undefined) {
      await withMemoryLock(out, async () => {
        await removeOwnedDirectory(out, owned!);
        if (ownedManifest !== undefined) {
          const current = await lstat(manifestPath(out), { bigint: true }).catch(() => undefined);
          if (current?.dev === ownedManifest.dev && current.ino === ownedManifest.ino && current.birthtimeNs === ownedManifest.birthtimeNs) await rm(manifestPath(out));
        }
      }).catch(cleanup => process.emitWarning("failed dream copy remains at " + out + "; cleanup: " + String(cleanup)));
    }
    throw error;
  }
}

/** Source content, paths, empty directories and symlink targets. Only the ROOT scheduling stamp
 * is excluded. Read errors and cycles fail visibly rather than hashing a silently partial tree.
 */
export async function fingerprint(root: string, opts: ScanOptions = {}): Promise<string> {
  const budget = new ScanBudget(opts);
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["root", (await stat(root)).mode & 0o777]));
  await walkTree(root, budget, {
    entry: async entry => {
      hash.update(JSON.stringify([entry.relative, entry.linkTarget === undefined ? "entry" : "link", entry.mode]));
      if (entry.linkTarget !== undefined) hash.update(JSON.stringify(entry.linkTarget));
      if (entry.kind === "directory") hash.update("directory");
      else hash.update(JSON.stringify(["file", entry.bytes!.length, createHash("sha256").update(entry.bytes!).digest("hex")]) + "\0");
    },
    leaveDirectory: async () => { hash.update("\0"); },
  }, true);
  return hash.digest("hex");
}

/** Apply only a registered, unchanged source snapshot. Backups and failed-restore artifacts are
 * retained. Cooperating writers serialize around the two-rename gap; unlocked readers do not.
 */
export async function applyDream(sourceRoot: string, outputRoot: string, stamp: string, opts: DreamFileOptions = {}): Promise<string> {
  new ScanBudget(opts);
  opts.signal?.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(stamp)) throw new Error("applyDream: invalid backup stamp");
  const src = await realpath(sourceRoot);
  const out = await realpath(outputRoot);
  if (overlaps(src, out)) throw new Error("applyDream: roots overlap; the dream must write to a copy");
  return locked([src, out], async () => {
    const manifest = await readManifest(out, opts);
    await verifyOutput(out, manifest);
    if (manifest.sourceRoot !== src || !sameIdentity(await identity(src), manifest.sourceIdentity)
      || await fingerprint(src, opts) !== manifest.sourceFingerprint) {
      throw new Error("applyDream: stale dream snapshot; live wiki changed; keep the artifact and rerun/review against current content");
    }
    const backup = src + ".before-dream-" + stamp;
    if (await exists(backup)) throw new Error("applyDream: " + backup + " already exists; refusing to overwrite a backup");
    const staged = await mkdtemp(src + ".dream-staged-" + stamp + "-");
    const stagedIdentity = await identity(staged);
    let preserveStage = false;
    try {
      await copyContents(out, staged, opts);
      // A concurrent completed review can advance scheduling metadata without changing content.
      const currentStamp = await readBoundedFile(join(src, ".last-dream"), 4096, opts.signal).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (currentStamp !== undefined) await writeFile(join(staged, ".last-dream"), currentStamp);
      opts.signal?.throwIfAborted();
      await rename(src, backup);
      // Once the original moved, finish or restore even if abort arrives during the rename.
      try { await rename(staged, src); }
      catch (error) {
        try {
          if (await exists(src)) throw new Error("source path became occupied; refusing to overwrite it");
          await rename(backup, src);
        } catch (restoreError) {
          preserveStage = true;
          throw new Error("applyDream failed AND could not restore the original. Your wiki is at " + backup
            + "; proposed wiki is at " + staged + ". Stop writers before restoring to " + src
            + ". (apply: " + String(error) + "; restore: " + String(restoreError) + ")", { cause: error });
        }
        throw error;
      }
      return backup;
    } finally {
      if (!preserveStage) {
        try { await removeOwnedDirectory(staged, stagedIdentity); }
        catch (error) { process.emitWarning("dream staging cleanup failed; inspect " + staged + ": " + String(error)); }
      }
    }
  }, opts);
}
