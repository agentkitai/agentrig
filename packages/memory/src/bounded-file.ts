import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { MaintenanceLimitError, positiveLimit } from "./maintenance.js";

/** Bound allocation even if a regular file grows after stat. Never drain a pipe/device. */
export async function readBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  positiveLimit("maxFileBytes", maxBytes);
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let result: Buffer;
  try {
    const info = await handle.stat();
    signal?.throwIfAborted();
    if (!info.isFile()) throw new Error(`maintenance requires a regular file: ${path}`);
    if (info.size > maxBytes) throw new MaintenanceLimitError(`maintenance file exceeds ${maxBytes} bytes: ${path}`);
    // A subarray retains its whole backing allocation. Keeping one per short read could
    // turn a small byte cap into many large retained buffers. Reuse one growing buffer.
    let buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, info.size + 1)));
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (total === buffer.length) {
        const next = Buffer.alloc(Math.min(maxBytes + 1, buffer.length * 2));
        buffer.copy(next, 0, 0, total); buffer = next;
      }
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new MaintenanceLimitError(`maintenance file exceeds ${maxBytes} bytes: ${path}`);
    }
    result = Buffer.from(buffer.subarray(0, total));
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  return result;
}
