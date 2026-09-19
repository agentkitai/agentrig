import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Read-only inventory: includes snapshots and unexpected files, not just JSONL logs.
 * Do not follow symlinks or print genuine session content in a failed assertion.
 */
export function snapshotStore(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(path: string, relative: string): void {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) entries[relative] = `link:${readlinkSync(path)}`;
    else if (stat.isDirectory()) {
      entries[relative] = "directory";
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      entries[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
    } else entries[relative] = `special:${stat.mode}`;
  }
  visit(root, ".");
  return entries;
}
