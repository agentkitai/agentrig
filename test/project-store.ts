import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Read-only inventory: includes snapshots and unexpected files, not just JSONL logs.
 * Do not follow symlinks or print genuine session content in a failed assertion.
 */
export function snapshotStore(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(path: string, relative: string): void {
    let stated = false;
    try {
      const stat = lstatSync(path);
      stated = true;
      if (stat.isSymbolicLink()) entries[relative] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        entries[relative] = "directory";
        for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      } else if (stat.isFile()) {
        entries[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
      } else entries[relative] = `special:${stat.mode}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An initially absent root is valid. An enumerated child, or a path already
      // stat'ed, disappearing invalidates the inventory rather than proving absence.
      if (relative === "." && !stated) return;
      throw new Error(`project-store guard: removed-during-inventory: ${path}; keep stores quiescent and rerun`, { cause: error });
    }
  }
  visit(root, ".");
  return entries;
}
