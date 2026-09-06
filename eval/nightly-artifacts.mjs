import { lstat, opendir, open, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** Fixed evaluator-selected trees only, never a submitted workspace or arbitrary glob. */
export async function retainNightlyArtifacts(work, destination, selections, limits = {}) {
  const cap = { entries: 2_000, bytes: 64 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, ...limits };
  const receipt = { complete: false, entries: 0, bytes: 0, files: [], missing: [] };
  async function copy(relative, depth = 0) {
    if (++receipt.entries > cap.entries || depth > 8) throw new Error('artifact entry cap');
    const source = join(work, relative), target = join(destination, relative);
    let before;
    try { before = await lstat(source); }
    catch (error) { if (error.code === 'ENOENT') { receipt.missing.push(relative); return; } throw error; }
    if (before.isSymbolicLink()) throw new Error('artifact symlink');
    if (before.isDirectory()) {
      await mkdir(target, { recursive: true });
      for await (const entry of await opendir(source)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(entry.name)) throw new Error('artifact name');
        await copy(`${relative}/${entry.name}`, depth + 1);
      }
      return;
    }
    if (!before.isFile() || before.nlink > 1 || before.size > cap.fileBytes || receipt.bytes + before.size > cap.bytes)
      throw new Error('artifact file cap or type');
    const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        throw new Error('artifact changed');
      const buffer = Buffer.alloc(before.size + 1); let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      bytes = buffer.subarray(0, count);
    } finally { await handle.close(); }
    const after = await lstat(source);
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== bytes.length
      || before.mtimeMs !== after.mtimeMs || bytes.length > cap.fileBytes || receipt.bytes + bytes.length > cap.bytes)
      throw new Error('artifact changed');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    receipt.bytes += bytes.length;
    receipt.files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  try {
    for (const relative of selections) {
      if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(relative) || relative.split('/').some(part => part === '..' || part === '.'))
        throw new Error('invalid artifact selection');
      // Refuse in-scope links in every ancestor, not only the final selected file.
      let path = work;
      for (const part of relative.split('/').slice(0, -1)) {
        path = join(path, part);
        const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('artifact ancestor');
      }
      await copy(relative);
    }
    receipt.complete = true;
  } catch { /* Partial evidence stays; generic error cannot echo process/path payloads. */ }
  return receipt;
}
