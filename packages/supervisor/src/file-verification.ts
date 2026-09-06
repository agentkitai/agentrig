import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HarnessEvent } from "@agentkitai/agentrig-core";

type Change = Extract<HarnessEvent, { type: "file.changed" }>;
/** Current local-worktree evidence, not proof of who wrote it or what existed historically. */
export async function verifyCurrentFile(change: Change, cwd: string, signal: AbortSignal): Promise<string | null> {
  if (change.op === "delete" || !/^[a-f0-9]{16}$/.test(change.contentHash)) return null;
  signal.throwIfAborted();
  const root = await realpath(cwd);
  const target = resolve(root, change.path);
  const inside = (path: string): boolean => {
    const rel = relative(root, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  // macOS /var -> /private/var (and caller-selected worktree aliases) can make an absolute
  // spelling lexically outside the canonical cwd while identifying a file inside it.
  const canonicalTarget = await realpath(target);
  if (!inside(canonicalTarget)) return null;
  // NOFOLLOW is not exposed on every supported platform; reject existing links portably too.
  if (!(await lstat(target)).isFile()) return null;
  signal.throwIfAborted();
  // NONBLOCK prevents a forged FIFO claim from parking observation. NOFOLLOW rejects a final
  // symlink; parent resolution above rejects escapes. External rename races are not an OS sandbox.
  const handle = await open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 1_048_576) return null;
    signal.throwIfAborted();
    const bytes = Buffer.alloc(1_048_577);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    signal.throwIfAborted();
    if (size > 1_048_576 || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return createHash("sha256").update(bytes.subarray(0, size)).digest("hex").slice(0, 16) === change.contentHash
      ? relative(root, canonicalTarget).split(sep).join("/") : null;
  } finally { await handle.close(); }
}
