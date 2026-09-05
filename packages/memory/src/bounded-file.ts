import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { MaintenanceLimitError, positiveLimit } from "./maintenance.js";

/** Bound allocation even if a regular file grows after stat. Never drain a pipe/device. */
export async function readBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  positiveLimit("maxFileBytes", maxBytes);
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`maintenance requires a regular file: ${path}`);
    if (info.size > maxBytes) throw new MaintenanceLimitError(`maintenance file exceeds ${maxBytes} bytes: ${path}`);
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new MaintenanceLimitError(`maintenance file exceeds ${maxBytes} bytes: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
