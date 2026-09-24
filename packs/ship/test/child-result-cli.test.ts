import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const script = fileURLToPath(new URL("../scripts/child-result.mjs", import.meta.url));
it("CLI returns envelope schema, verified PR, and failed-attempt exit 2 with retry notes", async () => {
  const schema = spawnSync(process.execPath, [script, "schema"], { encoding: "utf8" });
  expect(schema.status).toBe(0);
  expect(JSON.parse(schema.stdout)).toHaveProperty("properties.status.enum", ["pr", "blocked"]);
  const root = await mkdtemp(join(tmpdir(), "child-receipt-"));
  try {
    const file = join(root, "observations.json");
    const head = "a".repeat(40);
    const observations = { result: { status: "pr", pr: 7, head }, attempt: 1, previousNotes: [], scope: ["packs"], observedPr: { pr: 7, head } };
    await writeFile(file, JSON.stringify(observations));
    const valid = spawnSync(process.execPath, [script, "assess", file], { encoding: "utf8" });
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout)).toHaveProperty("action", "pr");
    await writeFile(file, JSON.stringify({ ...observations, result: {} }));
    const invalid = spawnSync(process.execPath, [script, "assess", file], { encoding: "utf8" });
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ action: "retry", attempt: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
