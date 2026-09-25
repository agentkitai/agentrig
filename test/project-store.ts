import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Read-only inventory: includes snapshots and unexpected files, not just JSONL logs.
 * The injected filesystem seam makes deletion races deterministic in regressions.
 * Do not follow symlinks or print genuine session content in a failed assertion.
 */
export function snapshotStore(root: string, io = { lstatSync, readdirSync, readFileSync, readlinkSync }): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(path: string, relative: string): void {
    let stat;
    try { stat = io.lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (relative === ".") return; // A store absent before enumeration is legitimate.
      throw new Error(`project-store guard: removed-during-inventory: ${path}`);
    }
    try {
      if (stat.isSymbolicLink()) entries[relative] = `link:${io.readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        entries[relative] = "directory";
        for (const name of io.readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      } else if (stat.isFile()) {
        entries[relative] = createHash("sha256").update(io.readFileSync(path)).digest("hex");
      } else entries[relative] = `special:${stat.mode}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`project-store guard: removed-during-inventory: ${path}`);
    }
  }
  visit(root, ".");
  return entries;
}
