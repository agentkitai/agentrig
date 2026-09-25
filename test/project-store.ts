import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const inventoryFs = { lstatSync, readdirSync, readFileSync, readlinkSync };

/** Read-only inventory: includes snapshots and unexpected files, not just JSONL logs.
 * Do not follow symlinks or print genuine session content in a failed assertion.
 * The IO seam lets tests delete entries at deterministic stat/read boundaries.
 */
export function snapshotStore(root: string, io = inventoryFs): Record<string, string> {
  const entries: Record<string, string> = {};
  function visit(path: string, relative: string): void {
    let observed = false;
    try {
      const stat = io.lstatSync(path);
      observed = true;
      if (stat.isSymbolicLink()) entries[relative] = `link:${io.readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        entries[relative] = "directory";
        for (const name of io.readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
      } else if (stat.isFile()) {
        entries[relative] = createHash("sha256").update(io.readFileSync(path)).digest("hex");
      } else entries[relative] = `special:${stat.mode}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only an initially absent root is valid. A listed child or stat'ed root
      // disappearing invalidates the proof, even if both inventories would match.
      if (relative === "." && !observed) return;
      throw new Error(`project-store guard: path removed during inventory: ${path}`, { cause: error });
    }
  }
  visit(root, ".");
  return entries;
}
