import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync, readdirSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotStore } from "../../../test/project-store.js";

vi.hoisted(() => vi.resetModules());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), readdirSync: vi.fn(fs.readdirSync),
    readlinkSync: vi.fn(fs.readlinkSync), lstatSync: vi.fn(fs.lstatSync) };
});
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["file", "directory", "link", "listed-child"] as const)("reports %s removed during inventory with its path", (kind) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "store-race-"))); roots.push(root);
  const path = join(root, "victim");
  if (kind === "directory") mkdirSync(path);
  else if (kind === "link") symlinkSync(root, path, process.platform === "win32" ? "junction" : "dir");
  else writeFileSync(path, "private");
  const fn = kind === "file" ? readFileSync : kind === "directory" ? readdirSync : kind === "link" ? readlinkSync : lstatSync;
  const original = vi.mocked(fn).getMockImplementation()!;
  vi.mocked(fn).mockImplementationOnce(((...args: any[]) => {
    // listed-child must let the root stat complete before deleting the enumerated child.
    if (kind === "listed-child") {
      vi.mocked(lstatSync).mockImplementationOnce(() => { rmSync(path); throw Object.assign(new Error("raw error"), { code: "ENOENT" }); });
      return (original as Function)(...args);
    }
    rmSync(path, { recursive: true });
    throw Object.assign(new Error("raw error"), { code: "ENOENT" });
  }) as never);
  expect(() => snapshotStore(kind === "listed-child" ? root : path)).toThrow(`project-store guard: removed-during-inventory: ${path}`);
});

it("does not suppress non-ENOENT read failures", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "store-race-"))); roots.push(root);
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
  expect(() => snapshotStore(root)).toThrow("permission denied");
});
