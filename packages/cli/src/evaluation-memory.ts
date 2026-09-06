import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Bounded immutable snapshot. Links/special files are refused, never followed into the host. */
export async function evaluationMemory(root: string, expected: string, destination?: string) {
  const canonical = await realpath(root);
  const hash = createHash("sha256");
  const files: Array<{ path: string; bytes: Buffer }> = [];
  let total = 0, entries = 0;
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error("evaluation memory depth limit exceeded");
    const names: string[] = [];
    for await (const entry of await opendir(directory)) {
      if (++entries > 1000) throw new Error("evaluation memory entry limit exceeded");
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      const file = join(directory, name), relative = `${prefix}${name}`;
      const stat = await lstat(file);
      if (stat.isDirectory()) { await visit(file, `${relative}/`, depth + 1); continue; }
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("evaluation memory must contain bounded regular files");
      const handle = await open(file, process.platform === "win32" ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== stat.size) throw new Error("evaluation memory changed while reading");
        const buffer = Buffer.alloc(1024 * 1024 + 1); let size = 0;
        while (size < buffer.length) {
          const next = await handle.read(buffer, size, buffer.length - size, size);
          if (!next.bytesRead) break;
          size += next.bytesRead;
        }
        const after = await handle.stat();
        if (size > 1024 * 1024 || size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) throw new Error("evaluation memory changed or exceeded its file limit");
        total += size;
        if (total > 16 * 1024 * 1024) throw new Error("evaluation memory exceeds 16 MiB");
        const bytes = Buffer.from(buffer.subarray(0, size));
        hash.update(`${relative.length}:${relative}:${size}:`).update(bytes);
        files.push({ path: relative, bytes });
      } finally { await handle.close(); }
    }
  }
  await visit(canonical, "", 0);
  const digest = hash.digest("hex");
  if (digest !== expected) throw new Error("evaluation frozen memory digest mismatch");
  if (destination !== undefined) {
    await mkdir(destination);
    for (const file of files) {
      await mkdir(dirname(join(destination, file.path)), { recursive: true });
      await writeFile(join(destination, file.path), file.bytes, { flag: "wx" });
    }
  }
  return { path: canonical, sha256: digest, files: files.length, bytes: total };
}
