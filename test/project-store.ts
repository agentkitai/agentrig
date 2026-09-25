import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Read-only inventory: includes snapshots and unexpected files, not just JSONL logs.
 * Do not follow symlinks or print genuine session content in a failed assertion.
 */
export function snapshotStore(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function removed(path: string): never {
    throw new Error(`project-store guard: removed-during-inventory: ${path}`);
  }
  function visit(path: string, relative: string): void {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (relative === ".") return; // A store absent at the start is a valid baseline.
      removed(path); // A child already observed by readdir cannot disappear silently.
    }
    try {
      if (stat.isSymbolicLink()) entries[relative] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        entries[relative] = "directory";
        for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      } else if (stat.isFile()) {
        entries[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
      } else entries[relative] = `special:${stat.mode}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") removed(path);
      throw error;
    }
  }
  visit(root, ".");
  return entries;
}
