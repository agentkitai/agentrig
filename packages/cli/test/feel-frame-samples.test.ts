import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("waits beyond sixteen events coalesced into fifteen writes, and rejects a permanent deficit", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { waitForDistinctFrames, distinctFrameCount } from './packages/cli/scripts/feel-frame-samples.mjs';
    const frames = Array.from({ length: 16 }, (_, i) => ({ frameId: Math.max(0, i - 1) }));
    const waiting = waitForDistinctFrames(frames, { timeoutMs: 1000 });
    setTimeout(() => frames.push({ frameId: 15 }), 30);
    await waiting;
    assert.equal(distinctFrameCount(frames), 16);
    await assert.rejects(waitForDistinctFrames(frames.slice(0, 16), { timeoutMs: 30 }), /16 distinct/);
    console.log('PASS: coalesced event wait');
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)) });
  expect(stdout).toContain("PASS: coalesced event wait");
});
