import { mkdtemp, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REPO_MAP_BYTES, RepoMapView, exportedSignatures, generateRepoMap } from "@agentkitai/agentrig-core";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentrig-repo-map-"));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("repository map", () => {
  it("honours its complete byte budget and truncates a huge tree deterministically", async () => {
    const root = await fixture();
    await mkdir(join(root, "src"));
    for (let i = 0; i < 200; i += 1) {
      await writeFile(join(root, "src", `${String(i).padStart(3, "0")}.ts`), `export function symbol${i}(value: string): number { return value.length; }\n`);
    }

    const first = await generateRepoMap(root, { maxBytes: 512 });
    const second = await generateRepoMap(root, { maxBytes: 512 });
    expect(first.bytes).toBeLessThanOrEqual(512);
    expect(first.truncated).toBe(true);
    expect(first.content).toBe(second.content);
    expect(first.content).toContain("src/000.ts");
    expect(first.content).not.toContain("src/199.ts");
    expect(first.content).toContain("repository map truncated");
  });

  it("extracts top-level TypeScript exports and signatures without executing source", async () => {
    const source = `
      export interface Widget { id: string; run(input: number): Promise<void> }
      export function findWidget(id: string, exact?: boolean): Widget { throw new Error("must not run"); }
      export const dangerous: () => never = (() => { throw new Error("must not run"); })();
      const privateValue = 1;
    `;
    const signatures = exportedSignatures("fixture.ts", source);
    expect(signatures).toContain("export interface Widget { id: string; run(input: number): Promise<void>; }");
    expect(signatures).toContain("export function findWidget(id: string, exact?: boolean): Widget");
    expect(signatures).toContain("export const dangerous: () => never");
    expect(signatures.join(" ")).not.toContain("must not run");
    expect(signatures.join(" ")).not.toContain("privateValue");
  });

  it("regenerates only after a path, size, or mtime changes", async () => {
    const root = await fixture();
    const path = join(root, "answer.ts");
    await writeFile(path, "export const before: number = 1;\n");
    const view = new RepoMapView(root);

    const first = await view.refresh();
    const unchanged = await view.refresh();
    expect(first.regenerated).toBe(true);
    expect(unchanged.regenerated).toBe(false);

    await writeFile(path, "export const after_: number = 2;\n");
    const future = new Date(Date.now() + 5_000);
    await utimes(path, future, future);
    const changed = await view.refresh();
    expect(changed.regenerated).toBe(true);
    expect(changed.map.freshness).not.toBe(first.map.freshness);
    expect(changed.map.content).toContain("export const after_: number");
  });

  it("keeps the map of this repository within the dogfood budget", async () => {
    const map = await generateRepoMap(process.cwd());
    expect(map.bytes).toBeLessThanOrEqual(DEFAULT_REPO_MAP_BYTES);
  });
});
