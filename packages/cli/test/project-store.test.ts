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
  expect(snapshotStore(root)).toEqual({});
  mkdirSync(root);
  const empty = snapshotStore(root);
  writeFileSync(join(root, "fixture.jsonl"), "SECRET_TASK");
  const log = snapshotStore(root);
  expect(log).not.toEqual(empty);
  expect(JSON.stringify(log)).not.toContain("SECRET_TASK");
  writeFileSync(join(root, "fixture.snapshot.json"), "snapshot");
  const snapshot = snapshotStore(root);
  expect(snapshot).not.toEqual(log);
  writeFileSync(join(root, "fixture.jsonl"), "SECRET_EDIT"); // same length, different bytes
  expect(snapshotStore(root)).not.toEqual(snapshot);
  rmSync(join(root, "fixture.jsonl"));
  expect(snapshotStore(root)).not.toEqual(snapshot);
  expect(snapshotStore(root)).toEqual(snapshotStore(root));
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
