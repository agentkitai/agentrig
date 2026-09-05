import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
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
  try {
    await handle.writeFile(owner, "utf8");
    opts.signal?.throwIfAborted();
    return await work();
  } finally {
    await handle.close();
    // Do not remove another owner's lock after out-of-band operator replacement.
    if (await readFile(lockPath, "utf8").catch(() => "") === owner) await rm(lockPath);
  }
}
