import { link, lstat, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withMemoryLock, type MemoryLockOptions } from "../lock.js";

export type DreamStampReset = { status: "absent" } | { status: "reset"; backup: string };

/** Explicit scheduling reset, not implicit scan recovery. Stop running/scheduled dreams first:
 * the root lock protects mutations, not model lifetimes. Never reads unbounded stamp content.
 * A hard link gives exclusive backup creation without moving/clobbering another backup. After
 * that succeeds, finish unlinking despite late cancellation; on failure retain/name both links.
 * No crash-time lock stealing, power-loss guarantee or hostile path-race guarantee.
 */
export async function resetDreamStamp(wikiRoot: string, opts: MemoryLockOptions = {}): Promise<DreamStampReset> {
  opts.signal?.throwIfAborted();
  const root = await realpath(wikiRoot);
  const initial = await lstat(root, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error("dream stamp reset requires an existing wiki directory");
  return withMemoryLock(root, async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev
      || current.ino !== initial.ino || current.birthtimeNs !== initial.birthtimeNs) {
      throw new Error("wiki root replaced; refusing dream stamp reset");
    }
    const path = join(root, ".last-dream");
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return { status: "absent" };
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("dream stamp is not a regular file; preserve and inspect " + path);
    const backup = root + ".last-dream-before-reset-" + randomUUID();
    opts.signal?.throwIfAborted();
    await link(path, backup);
    // Once the backup exists, do not falsely report an uncommitted cancellation.
    try { await unlink(path); }
    catch (error) {
      throw new Error("dream stamp reset incomplete; original remains at " + path + "; backup preserved at " + backup
        + "; stop writers and inspect both before retrying: " + String(error), { cause: error });
    }
    return { status: "reset", backup };
  }, opts);
}
