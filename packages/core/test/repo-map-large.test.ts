import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_REPO_MAP_BYTES, generateRepoMap } from "@agentkitai/agentrig-core";

const virtual = vi.hoisted(() => ({ root: "", files: 200_000 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    async readdir(path: string, options: never) {
      if (path !== virtual.root) return actual.readdir(path, options);
      return Array.from({ length: virtual.files }, (_, i) => ({
        name: `file-${String(i).padStart(6, "0")}.md`, isDirectory: () => false, isFile: () => true,
      }));
    },
    async stat(path: string, options: never) {
      if (virtual.root !== "" && dirname(path) === virtual.root) return { size: 0n, mtimeNs: 0n };
      return actual.stat(path, options);
    },
  };
});
let root: string | undefined;
afterEach(async () => {
  virtual.root = "";
  if (root !== undefined) { await rm(root, { recursive: true, force: true }); root = undefined; }
});

it("bounds a 200,000-file map without spreading its paths into engine call arguments", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-large-map-")));
  virtual.root = root;
  // Virtual directory metadata avoids 200,000 disk writes. The actual public scanner,
  // path ordering, formatter and byte-bound logic run; existing tests cover real filesystem IO.
  const map = await generateRepoMap(root);
  expect(map.files).toBe(virtual.files);
  expect(map.truncated).toBe(true);
  expect(map.bytes).toBeLessThanOrEqual(DEFAULT_REPO_MAP_BYTES);
  expect(map.content).toContain("file-000000.md");
  expect(map.content).toContain("repository map truncated to byte budget");
  expect(map.content).not.toContain("file-199999.md");
});
