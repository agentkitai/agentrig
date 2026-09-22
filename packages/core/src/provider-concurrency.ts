import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ModelProvider } from "./provider.js";

/** Filesystem slots coordinate separate train/run processes, not just roles in one builder.
 * A crash leaves its slot occupied: reconcile the recorded PID before operator removal.
 * Never expire a live long-running provider call on a wall-clock lease.
 */
export function limitProvider(provider: ModelProvider, options: { root: string; entry: string; maxConcurrent: number }): ModelProvider {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) throw new Error("maxConcurrent must be a positive safe integer");
  const directory = join(options.root, createHash("sha256").update(options.entry).digest("hex"));
  return { id: provider.id, model: provider.model, capabilities: provider.capabilities,
    ...(provider.validateHistory === undefined ? {} : { validateHistory: provider.validateHistory.bind(provider) }),
    ...(provider.countTokens === undefined ? {} : { countTokens: provider.countTokens.bind(provider) }),
    async *stream(request, signal) {
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let slot: string | undefined;
      let notified = false;
      try {
        while (slot === undefined) {
          signal.throwIfAborted();
          for (let index = 0; index < options.maxConcurrent; index++) {
            const path = join(directory, `${index}.lock`);
            let file;
            try { file = await open(path, "wx", 0o600); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
            slot = path;
            try { await file.writeFile(JSON.stringify({ pid: process.pid, entry: options.entry, started: new Date().toISOString() }) + "\n"); }
            finally { await file.close(); }
            break;
          }
          if (slot === undefined) {
            if (!notified) { notified = true; yield { type: "wait", entry: options.entry, maxConcurrent: options.maxConcurrent }; }
            await setTimeout(25, undefined, { signal });
          }
        }
        signal.throwIfAborted();
        yield* provider.stream(request, signal);
      } finally { if (slot !== undefined) await rm(slot); }
    },
  };
}
