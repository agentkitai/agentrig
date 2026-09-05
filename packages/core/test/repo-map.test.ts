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
  it("excludes generated checkouts before budgeting and freshness without hiding instructions", async () => {
    const root = await fixture();
    const generated = [".claude/worktrees/review", ".worktrees/task", "nested/.claude/worktrees/task"];
    for (const dir of [...generated, ".claude/commands", "packages/core/src", "packages/memory/src", "packages/supervisor/src"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, "CLAUDE.md"), "Project instructions");
    await writeFile(join(root, ".claude/commands/review.md"), "Review instructions");
    for (const pkg of ["core", "memory", "supervisor"]) {
      await writeFile(join(root, `packages/${pkg}/src/index.ts`), "export const visible: boolean = true;");
    }
    for (const dir of generated) {
      for (let i = 0; i < 100; i++) await writeFile(join(root, dir, `generated-${i}.ts`), "export const noise = 1;");
    }
    const view = new RepoMapView(root);
    const first = await view.refresh();
    expect(first.map.files).toBe(5);
    expect(first.map.truncated).toBe(false);
    expect(first.map.content).toContain("CLAUDE.md");
    expect(first.map.content).toContain(".claude/commands/review.md");
    for (const pkg of ["core", "memory", "supervisor"]) expect(first.map.content).toContain(`packages/${pkg}/src/index.ts`);
    expect(first.map.content).not.toContain("generated-");
    await writeFile(join(root, generated[0]!, "extra.ts"), "new checkout activity");
    const unchanged = await view.refresh();
    expect(unchanged.regenerated).toBe(false);
    expect(unchanged.map.freshness).toBe(first.map.freshness);
    await writeFile(join(root, ".claude/commands/review.md"), "Changed project instructions");
    expect((await view.refresh()).regenerated).toBe(true);
  });

  it("retains ordinary worktrees directories and submodules, and supports explicit checkout exclusions", async () => {
    const root = await fixture();
    for (const dir of ["worktrees", "vendor/lib", "custom-checkouts/review"]) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "worktrees/design.md"), "Legitimate project content");
    await writeFile(join(root, "vendor/lib/.git"), "gitdir: ../../.git/modules/lib\n");
    await writeFile(join(root, "vendor/lib/index.ts"), "export const library = 1;");
    await writeFile(join(root, "custom-checkouts/review/noise.ts"), "export const noise = 1;");
    const map = await generateRepoMap(root, { excludePaths: [join(root, "custom-checkouts")] });
    expect(map.content).toContain("worktrees/design.md");
    expect(map.content).toContain("vendor/lib/index.ts");
    expect(map.content).not.toContain("noise.ts");
  });

  it("maps a generated checkout normally when it is the requested root", async () => {
    const root = join(await fixture(), ".claude/worktrees/task");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Checkout instructions");
    await writeFile(join(root, "index.ts"), "export const ownProject = 1;");
    const map = await generateRepoMap(root);
    expect(map.files).toBe(2);
    expect(map.content).toContain("AGENTS.md");
    expect(map.content).toContain("index.ts");
  });

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
      export namespace PublicApi { export function hiddenBody() { return "implementation secret"; } }
      export default (() => "default implementation secret")();
      const privateValue = 1;
    `;
    const signatures = await exportedSignatures("fixture.ts", source);
    expect(signatures.join("\n")).toMatch(/export interface Widget[\s\S]*id: string;[\s\S]*run\(input: number\): Promise<void>/);
    expect(signatures).toContain("export function findWidget(id: string, exact?: boolean): Widget");
    expect(signatures).toContain("export const dangerous: () => never");
    expect(signatures.join(" ")).not.toContain("must not run");
    expect(signatures).toContain("export namespace PublicApi");
    expect(signatures.join(" ")).not.toContain("implementation secret");
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

  it("keeps this repository's whole tree visible within the dogfood budget", async () => {
    const map = await generateRepoMap(process.cwd());
    expect(map.bytes).toBeLessThanOrEqual(DEFAULT_REPO_MAP_BYTES);
    expect(map.files).toBeGreaterThan(100);
    // A symbol-heavy early package must not starve later packages from the structural tree.
    expect(map.content).toContain("packages/core/src/agent.ts");
    expect(map.content).toContain("packages/memory/src/index.ts");
    expect(map.content).toContain("packages/supervisor/src/index.ts");
  });
});
