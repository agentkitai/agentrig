import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
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

// Deterministically remove an entry after stat, immediately before its next read.
it.each(["readFileSync", "readdirSync", "readlinkSync"] as const)("reports removed-during-inventory for %s", operation => {
  const root = fixture();
  const path = join(root, "vanishing");
  if (operation === "readFileSync") writeFileSync(path, "PRIVATE_CONTENT");
  else if (operation === "readdirSync") mkdirSync(path);
  else symlinkSync(fixture(), path, process.platform === "win32" ? "junction" : "dir");
  const io = { ...fs };
  const original = fs[operation];
  const spy = vi.spyOn(io, operation).mockImplementation(((...args: unknown[]) => {
    if (args[0] === path) rmSync(path, { recursive: true, force: true });
    return (original as (...args: unknown[]) => unknown)(...args);
  }) as never);
  try {
    expect(() => snapshotStore(root, io)).toThrow(`project-store guard: removed-during-inventory: ${path}`);
  } finally { spy.mockRestore(); }
});

it("reports an enumerated entry disappearing before stat rather than ignoring it", () => {
  const root = fixture();
  const path = join(root, "vanishing");
  writeFileSync(path, "private");
  const io = { ...fs };
  const original = fs.lstatSync;
  const spy = vi.spyOn(io, "lstatSync").mockImplementation(((target: fs.PathLike) => {
    if (target === path) rmSync(path);
    return original(target);
  }) as typeof fs.lstatSync);
  try { expect(() => snapshotStore(root, io)).toThrow(`project-store guard: removed-during-inventory: ${path}`); }
  finally { spy.mockRestore(); }
});

it.each(["lstatSync", "readdirSync"] as const)("does not swallow non-ENOENT inventory errors from %s", operation => {
  const root = fixture();
  const io = { ...fs };
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  const spy = vi.spyOn(io, operation).mockImplementation(() => { throw error; });
  try { expect(() => snapshotStore(root, io)).toThrow(error); }
  finally { spy.mockRestore(); }
});
