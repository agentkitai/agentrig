import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compatibilityCopies, syncCompatibility } from "../compatibility.mjs";

it("M-compatibility-drift: checks without rewriting; regeneration restores each skill and policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ship-copies-"));
  try {
    const copies = await compatibilityCopies();
    expect(copies.size).toBe(7);
    await syncCompatibility(root, true);
    expect(await syncCompatibility(root)).toEqual([]);
    for (const [path, text] of copies) {
      await writeFile(join(root, path), text + "\nDRIFT\n");
      expect(await syncCompatibility(root)).toEqual([path]);
      expect(await readFile(join(root, path), "utf8")).toContain("DRIFT");
      await syncCompatibility(root, true);
    }
    // Git's Windows checkout conversion is not policy drift.
    for (const [path, text] of copies) await writeFile(join(root, path), text.replace(/\n/g, "\r\n"));
    expect(await syncCompatibility(root)).toEqual([]);
    await rm(join(root, ".agentrig/skills/ship/SKILL.md"));
    expect(await syncCompatibility(root)).toEqual([".agentrig/skills/ship/SKILL.md"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
