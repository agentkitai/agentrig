import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotStore } from "../../../test/project-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentrig-store-guard-")));
  roots.push(root);
  return root;
}

it("inventories absent stores, log creation, snapshots, rewrites and deletion without revealing content", () => {
  const root = join(fixture(), "sessions");
  const absent = snapshotStore(root);
  expect(absent).toEqual({});
  mkdirSync(root);
  const empty = snapshotStore(root);
  expect(empty).not.toEqual(absent);
  mkdirSync(join(root, "empty-nested"));
  const nested = snapshotStore(root);
  expect(nested).not.toEqual(empty);
  writeFileSync(join(root, "fixture.jsonl"), "SECRET_TASK");
  const log = snapshotStore(root);
  expect(log).not.toEqual(nested);
  expect(JSON.stringify(log)).not.toContain("SECRET_TASK");
  writeFileSync(join(root, "fixture.snapshot.json"), "snapshot");
  const snapshot = snapshotStore(root);
  expect(snapshot).not.toEqual(log);
  writeFileSync(join(root, "fixture.jsonl"), "SECRET_EDIT"); // same length, different bytes
  const rewritten = snapshotStore(root);
  expect(rewritten).not.toEqual(snapshot);
  rmSync(join(root, "fixture.jsonl"));
  const deleted = snapshotStore(root);
  expect(deleted).not.toEqual(rewritten);
  expect(deleted["./fixture.jsonl"]).toBeUndefined();
});

it("includes nested artifacts but does not traverse symlinks outside the store", () => {
  const root = fixture();
  const outside = fixture();
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "artifact"), "original");
  symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  const before = snapshotStore(root);
  writeFileSync(join(outside, "genuine-session"), "private");
  expect(snapshotStore(root)).toEqual(before);
  writeFileSync(join(root, "nested", "artifact"), "modified");
  expect(snapshotStore(root)).not.toEqual(before);
});

// Deterministic mid-inventory races, without timing-dependent background deletion.
const races = vi.hoisted(() => { vi.resetModules(); return { operation: "", path: "", code: "ENOENT" }; });
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return Object.fromEntries(Object.entries(fs).map(([name, value]) => [name,
    ["readFileSync", "readdirSync", "readlinkSync", "lstatSync"].includes(name)
      ? (...args: unknown[]) => {
        if (races.operation === name && args[0] === races.path) {
          throw Object.assign(new Error("simulated removal"), { code: races.code });
        }
        return (value as (...args: unknown[]) => unknown)(...args);
      } : value,
  ]));
});
it.each([
  ...["readFileSync", "readdirSync", "readlinkSync", "lstatSync"].map(operation => [operation, false] as const),
  ...["readFileSync", "readdirSync", "readlinkSync"].map(operation => [operation, true] as const),
])(
  "reports the affected path removed during inventory at %s (root=%s)", (operation, atRoot) => {
    const root = fixture();
    const path = join(root, "removed");
    if (operation === "readdirSync") mkdirSync(path);
    else if (operation === "readlinkSync") symlinkSync(fixture(), path, process.platform === "win32" ? "junction" : "dir");
    else writeFileSync(path, "private");
    races.operation = operation;
    races.path = path;
    try {
      expect(snapshotStore(atRoot ? path : root)[atRoot ? "." : "./removed"]).toBe("removed-during-inventory");
    } finally { races.operation = ""; races.path = ""; }
  },
);

it("keeps non-ENOENT inventory failures fatal", () => {
  const root = fixture();
  races.operation = "readdirSync";
  races.path = root;
  races.code = "EACCES";
  try { expect(() => snapshotStore(root)).toThrow("simulated removal"); }
  finally { races.operation = ""; races.path = ""; races.code = "ENOENT"; }
});
