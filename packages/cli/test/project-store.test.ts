import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
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

it.each(["lstatSync", "readdirSync", "readFileSync", "readlinkSync"] as const)(
  "reports paths removed during %s rather than certifying a partial inventory", async (operation) => {
    const fs = await import("node:fs");
    const root = fixture();
    const target = join(root, "vanishing");
    if (operation === "readdirSync") mkdirSync(target);
    else if (operation === "readlinkSync") symlinkSync(fixture(), target, process.platform === "win32" ? "junction" : "dir");
    else writeFileSync(target, "private content");
    let removed = false;
    const io = { ...fs, [operation]: (...args: unknown[]) => {
      if (args[0] === target) { rmSync(target, { recursive: true }); removed = true; }
      return (fs[operation] as (...args: unknown[]) => unknown)(...args);
    } };
    expect(() => snapshotStore(root, io)).toThrow(`project-store guard: path removed during inventory: ${target}`);
    expect(removed).toBe(true);
  },
);

it("reports disappearance of an already observed root and preserves other IO errors", async () => {
  const fs = await import("node:fs");
  const root = fixture();
  expect(() => snapshotStore(root, { ...fs, readdirSync: (() => {
    rmSync(root, { recursive: true });
    return fs.readdirSync(root);
  }) as typeof fs.readdirSync })).toThrow(`path removed during inventory: ${root}`);
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  expect(() => snapshotStore(root, { ...fs, lstatSync: () => { throw denied; } })).toThrow(denied);
});
