import { mkdtemp, rm, utimes, writeFile, mkdir, symlink } from "node:fs/promises";
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
    expect(map.content).not.toContain("vendor/lib/.git");
    expect(map.content).not.toContain("noise.ts");
  });

  it("maps a generated checkout normally when it is the requested root", async () => {
    const root = join(await fixture(), ".claude/worktrees/task");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Checkout instructions");
    await writeFile(join(root, "index.ts"), "export const ownProject = 1;");
    await writeFile(join(root, ".git"), "gitdir: /project/.git/worktrees/task\n");
    const map = await generateRepoMap(root);
    expect(map.files).toBe(2);
    expect(map.content).toContain("AGENTS.md");
    expect(map.content).toContain("index.ts");
  });

  it("prunes linked checkouts in arbitrary containers, but not adjacent ordinary content", async () => {
    const root = await fixture();
    for (const dir of ["worktrees/review", "custom/branch", "worktrees/docs", "packages/main"]) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, "worktrees/review/.git"), "gitdir: ../../.git/worktrees/review\n");
    await writeFile(join(root, "custom/branch/.git"), "gitdir: C:\\project\\.git\\worktrees\\branch\r\n");
    for (const dir of ["worktrees/review", "custom/branch"]) {
      for (let i = 0; i < 100; i++) await writeFile(join(root, dir, `noise-${i}.ts`), "export const noise = 1;");
    }
    await writeFile(join(root, "worktrees/docs/design.md"), "Ordinary content");
    await writeFile(join(root, "packages/main/index.ts"), "export const project = 1;");
    const view = new RepoMapView(root);
    const first = await view.refresh();
    expect(first.map.files).toBe(2);
    expect(first.map.content).toContain("worktrees/docs/design.md");
    expect(first.map.content).toContain("packages/main/index.ts");
    expect(first.map.content).not.toContain("noise-");
    await writeFile(join(root, "worktrees/review/new.ts"), "New checkout activity");
    expect((await view.refresh()).regenerated).toBe(false);
  });

  it("canonicalizes exclusions when the requested root uses a directory alias", async () => {
    const outer = await fixture();
    const root = join(outer, "physical");
    const alias = join(outer, "alias");
    await mkdir(join(root, "excluded"), { recursive: true });
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(root, "excluded/noise.ts"), "export const noise = 1;");
    await writeFile(join(root, "visible.ts"), "export const visible = 1;");
    const view = new RepoMapView(alias, { excludePaths: [join(alias, "excluded")] });
    const first = await view.refresh();
    expect(first.map.files).toBe(1);
    expect(first.map.content).not.toContain("noise.ts");
    await writeFile(join(root, "excluded/another.ts"), "Changed excluded tree");
    expect((await view.refresh()).regenerated).toBe(false);
  });

  it("does not treat malformed, oversized or symlinked gitfiles as checkout markers", async () => {
    const root = await fixture();
    for (const dir of ["malformed", "oversized", "symlinked"]) {
      await mkdir(join(root, dir));
      await writeFile(join(root, dir, "AGENTS.md"), "Keep these project instructions");
    }
    await writeFile(join(root, "malformed/.git"), "not a gitdir: /project/.git/worktrees/task\n");
    await writeFile(join(root, "oversized/.git"), `gitdir: /${"x".repeat(4096)}/.git/worktrees/task\n`);
    // Keep the symlink target inside the fixture but outside the requested map root.
    const marker = join(await fixture(), "marker");
    await writeFile(marker, "gitdir: /project/.git/worktrees/task\n");
    if (process.platform !== "win32") await symlink(marker, join(root, "symlinked/.git"));
    const map = await generateRepoMap(root);
    expect(map.files).toBe(3);
    for (const dir of ["malformed", "oversized", "symlinked"]) expect(map.content).toContain(`${dir}/AGENTS.md`);
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

  it("keeps every file visible before symbol detail when the tree fits the default budget", async () => {
    const root = await fixture();
    const paths = ["packages/cli/src/index.ts", "packages/core/src/agent.ts", "packages/memory/src/index.ts", "packages/supervisor/src/index.ts"];
    for (const path of paths) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), path.includes("agent.ts")
        ? Array.from({ length: 400 }, (_, i) => `export const symbol_${i}: number = ${i};`).join("\n")
        : "export const present: boolean = true;");
    }
    const map = await generateRepoMap(root);
    expect(map.bytes).toBeLessThanOrEqual(DEFAULT_REPO_MAP_BYTES);
    expect(map.files).toBe(paths.length);
    expect(map.truncated).toBe(true); // Symbols exceed the cap, the controlled file list does not.
    expect(map.content).toContain("Exports:");
    expect(map.content).toContain("export const symbol_0");
    const tree = map.content.split("\nExports:")[0]!;
    for (const path of paths) expect(tree).toContain(`- ${path}`);
  });

  it("bounds this growing checkout and reports any truncation honestly", async () => {
    const map = await generateRepoMap(process.cwd());
    expect(map.bytes).toBeLessThanOrEqual(DEFAULT_REPO_MAP_BYTES);
    expect(map.files).toBeGreaterThan(100);
    expect(map.content).toContain("BEGIN REPOSITORY MAP");
    expect(map.content).toContain("END REPOSITORY MAP");
    expect(map.content.includes("repository map truncated")).toBe(map.truncated);
  });
});
