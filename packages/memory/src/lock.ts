import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface MemoryLockOptions { signal?: AbortSignal; timeoutMs?: number }

/** Shared by cooperating writers, including separate store instances/processes. No age-based
 * stealing: crash recovery requires stopping writers and removing the named lock manually. */
export async function withMemoryLock<T>(root: string, work: () => Promise<T>, opts: MemoryLockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("invalid memory lock timeout");
  opts.signal?.throwIfAborted();
  const absolute = resolve(root);
  await mkdir(dirname(absolute), { recursive: true });
  const physical = await realpath(absolute).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return join(await realpath(dirname(absolute)), basename(absolute));
  });
  // Outside the wiki content tree so copies do not inherit locks. H5c will coordinate swaps.
  const lockPath = `${physical}.write.lock`;
  const deadline = performance.now() + timeoutMs;
  const owner = `${process.pid}:${randomUUID()}\n`;
  let handle;
  for (;;) {
    opts.signal?.throwIfAborted();
    try { handle = await open(lockPath, "wx", 0o600); break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (performance.now() >= deadline) throw new Error(`timed out waiting for memory lock ${lockPath}; if its owner crashed, stop all writers before removing that lock`);
      await delay(Math.min(20, Math.max(1, deadline - performance.now())), undefined,
        opts.signal === undefined ? {} : { signal: opts.signal });
    }
  }
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(owner, "utf8");
    opts.signal?.throwIfAborted();
    return await work();
  } finally {
    try {
      // Keep the handle open during the identity check so its inode cannot be reused.
      // A failed/partial marker write must not leak our lock, nor erase a replacement owner.
      const current = await lstat(lockPath, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
      });
      if (identity !== undefined && current?.dev === identity.dev && current.ino === identity.ino) await rm(lockPath);
    } finally { await handle.close(); }
  }
}
