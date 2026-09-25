import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotStore } from "../../../test/project-store.js";

vi.hoisted(() => vi.resetModules());
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync), readlinkSync: vi.fn(actual.readlinkSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(["lstatSync", "readdirSync", "readFileSync", "readlinkSync"] as const)(
  "fails closed with the removed path when %s races deletion", async operation => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agentrig-inventory-race-")));
    roots.push(root);
    const path = operation === "readdirSync" ? root : join(root, "entry");
    if (operation === "readlinkSync") {
      const target = join(root, "target"); fs.mkdirSync(target);
      fs.symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    } else if (path !== root) fs.writeFileSync(path, "PRIVATE_CONTENT");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let removed = false;
    // Delete at the real syscall boundary, after enumeration/stat, not on a timer.
    vi.mocked(fs[operation]).mockImplementation(((...args: unknown[]) => {
      if (args[0] === path && !removed) { removed = true; fs.rmSync(path, { recursive: true }); }
      return (actual[operation] as (...values: unknown[]) => unknown)(...args);
    }) as never);
    let error: unknown;
    try { snapshotStore(root); } catch (caught) { error = caught; }
    expect(removed).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("project-store guard: removed-during-inventory");
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).not.toContain("PRIVATE_CONTENT");
    expect((error as Error).cause).toMatchObject({ code: "ENOENT" });
  },
);

it("keeps non-ENOENT errors fatal and unchanged", () => {
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  vi.mocked(fs.lstatSync).mockImplementationOnce(() => { throw error; });
  expect(() => snapshotStore("unreadable")).toThrow(error);
});
