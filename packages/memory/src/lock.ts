import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface MemoryLockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Release failures are warnings, never a replacement for the work's committed outcome. */
  onReleaseError?: (error: Error) => void;
}

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
  let accessDeadline: number | undefined;
  for (;;) {
    opts.signal?.throwIfAborted();
    try { handle = await open(lockPath, "wx", 0o600); break; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows can briefly report access/busy errors while the last deleted handle closes.
      if (code === "EEXIST") accessDeadline = undefined;
      const accessError = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code ?? "");
      if (accessError) accessDeadline ??= performance.now() + 250;
      const retryable = code === "EEXIST" || (accessError && performance.now() < accessDeadline!);
      if (!retryable) throw new Error(`cannot acquire memory lock ${lockPath}: ${(err as Error).message}; check parent-directory permissions or persistent Windows delete-pending/busy state`, { cause: err });
      if (performance.now() >= deadline) throw new Error(`timed out waiting for memory lock ${lockPath} (${code}); check parent-directory permissions; if its owner crashed, stop all writers before removing that lock`);
      await delay(Math.min(20, Math.max(1, deadline - performance.now())), undefined,
        opts.signal === undefined ? {} : { signal: opts.signal });
    }
  }
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    try { identity = await handle.stat({ bigint: true }); }
    catch (error) {
      throw new Error(`cannot establish memory lock identity at ${lockPath}; no work ran; if release cannot verify ownership, stop all writers before removing that lock`, { cause: error });
    }
    await handle.writeFile(owner, "utf8");
    opts.signal?.throwIfAborted();
    return await work();
  } finally {
    const releaseErrors: unknown[] = [];
    try {
      // Keep the handle open during the identity check so its inode cannot be reused.
      // Retry a failed initial fstat before cleanup; never blindly unlink an unidentified lock.
      identity ??= await handle.stat({ bigint: true });
      // This narrows replacement-owner deletion to the lstat→unlink window, not an atomic guarantee.
      const current = await lstat(lockPath, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
      });
      if (current?.dev === identity.dev && current.ino === identity.ino) await rm(lockPath, { force: true });
    } catch (error) { releaseErrors.push(error); }
    try { await handle.close(); } catch (error) { releaseErrors.push(error); }
    for (const error of releaseErrors) {
      const warning = new Error(`memory lock release failed at ${lockPath}: ${String(error)}; operation outcome is unchanged; stop writers before lock recovery`);
      try {
        if (opts.onReleaseError !== undefined) opts.onReleaseError(warning);
        else process.emitWarning(warning.message, { code: "AGENTRIG_MEMORY_LOCK_RELEASE" });
      } catch { process.emitWarning(warning.message, { code: "AGENTRIG_MEMORY_LOCK_RELEASE" }); }
    }
  }
}
