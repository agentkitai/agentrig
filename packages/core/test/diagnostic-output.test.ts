import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { JobRegistry } from "@agentkitai/agentrig-core";
import { TscDiagnosticOutput, TSC_LINE_BYTES, TSC_METADATA_BYTES } from "../src/diagnostic-output.js";
import { defaultKillTree } from "../src/tools/bash.js";

const roots: string[] = [];
const jobs: JobRegistry[] = [];
afterEach(async () => {
  for (const registry of jobs.splice(0)) {
    registry.disposeAll();
    await Promise.all(registry.ids().map(id => registry.get(id)!.done));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(max = 65536) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-diagnostic-stream-"))); roots.push(root);
  const path = join(root, "tärgét.ts"); await writeFile(path, "export const x = 1;\n");
  const abort = new AbortController();
  return { root, path, abort, sink: new TscDiagnosticOutput(path, max, abort.signal) };
}

it("decodes split UTF-8 and CRLF without mixing independent stdout/stderr partial lines", async () => {
  const { path, sink } = await fixture();
  const listed = Buffer.from(path + "\r\n"), error = Buffer.from(`${path}(1,2): error TS2322: érrör\n`);
  // Deliberately split every multibyte sequence; OS coalescing cannot make this probe vacuous.
  for (let i = 0; i < Math.max(listed.length, error.length); i++) {
    if (i < listed.length) sink.write(listed.subarray(i, i + 1), "stdout");
    if (i < error.length) sink.write(error.subarray(i, i + 1), "stderr");
  }
  await sink.end();
  expect(sink.touchedFileListed).toBe(true);
  expect(sink.text).toBe(error.toString());
});

it("absolute diagnostic lines and stderr paths cannot be consumed as coverage", async () => {
  const { path, sink } = await fixture();
  const diagnostic = `${path}(1,1): error TS2322: actual error\n`;
  sink.write(Buffer.from(diagnostic), "stdout");
  sink.write(Buffer.from(path + "\n"), "stderr");
  await sink.end();
  expect(sink.touchedFileListed).toBe(false);
  expect(sink.text).toBe(diagnostic + path + "\n");
});

it.each([false, true])("diagnostic overflow still fails with metadata first=%s", async first => {
  const { path, sink } = await fixture(4096);
  if (first) sink.write(Buffer.from(path + "\n"), "stdout");
  const line = Buffer.from("target.ts(1,1): error TS1234: " + "x".repeat(4000) + "\n");
  sink.write(line, "stdout");
  expect(() => sink.write(line, "stderr")).toThrow("checker output exceeded bound");
  expect(Buffer.byteLength(sink.text)).toBeLessThanOrEqual(4096);
});

it("metadata has its own finite byte bound independent of the diagnostic allowance", async () => {
  const { path, sink } = await fixture(4096);
  const line = Buffer.from(path + "\n"), count = Math.floor(TSC_METADATA_BYTES / line.length);
  for (let i = 0; i < count; i++) sink.write(line, "stdout");
  expect(sink.text).toBe("");
  expect(() => sink.write(line, "stdout")).toThrow("checker coverage metadata exceeded bound");
});

it.each([false, true])("overlong complete/partial lines fail with terminated=%s", async terminated => {
  const { sink } = await fixture();
  expect(() => sink.write(Buffer.from("x".repeat(TSC_LINE_BYTES + 1) + (terminated ? "\n" : "")), "stdout"))
    .toThrow("checker output line exceeded bound");
});

it("unfinished UTF-8 and unterminated metadata cannot produce a complete witness", async () => {
  const { path, sink } = await fixture();
  sink.write(Buffer.from([0xc3]), "stdout");
  await expect(sink.end()).rejects.toThrow();
  const other = new TscDiagnosticOutput(path, 65536, new AbortController().signal);
  other.write(Buffer.from(path), "stdout");
  await expect(other.end()).rejects.toThrow("metadata ended without newline");
});

it.each([false, true])("unresolvable metadata stays incomplete even after witness=%s", async first => {
  const { root, path, sink } = await fixture();
  const missing = join(root, "not-a-real-path malformed output");
  sink.write(Buffer.from(first ? `${path}\n${missing}\n` : `${missing}\n${path}\n`), "stdout");
  await expect(sink.end()).rejects.toThrow("coverage path could not be verified");
});

it("abort before final canonicalization cannot grant coverage", async () => {
  const { path, sink, abort } = await fixture();
  sink.write(Buffer.from(path + "\n"), "stdout"); abort.abort();
  await expect(sink.end()).rejects.toThrow();
  expect(sink.touchedFileListed).toBe(false);
});

it("owned process completion joins the sink's final work", async () => {
  const { root, abort } = await fixture();
  const registry = new JobRegistry(); jobs.push(registry);
  let release!: () => void, started!: () => void, finished = false, observed = "";
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const { id } = registry.start({command: process.execPath, args: ["-e", "process.stdout.write('payload')"], cwd: root,
    isWindows: process.platform === "win32", killTree: defaultKillTree, signal: abort.signal,
    outputConsumer: {write: chunk => { observed += chunk.toString(); }, async end() { started(); await gate; finished = true; }}});
  const record = registry.get(id)!;
  try { await entered; expect(record.exited).toBe(false); expect(finished).toBe(false); }
  finally { release(); await record.done; }
  expect(finished).toBe(true); expect(observed).toBe("payload"); expect(record.exitCode).toBe(0);
  expect(record.outputError).toBeUndefined();
});

it.each(["write", "end"] as const)("sink %s errors remain explicit and its process is joined", async where => {
  const { root, abort } = await fixture();
  const registry = new JobRegistry(); jobs.push(registry);
  const { id } = registry.start({command: process.execPath, args: ["-e", "process.stdout.write('payload')"], cwd: root,
    isWindows: process.platform === "win32", killTree: defaultKillTree, signal: abort.signal,
    outputConsumer: {write() { if (where === "write") throw new Error("sink failed"); }, async end() { if (where === "end") throw new Error("sink failed"); }}});
  const record = registry.get(id)!; await record.done;
  expect(record.exited).toBe(true); expect(record.outputError).toBe("sink failed");
});

it.skipIf(process.platform === "win32")("forced inherited-pipe closure is incomplete, not silent success", async () => {
  const { root, path, abort, sink } = await fixture();
  const registry = new JobRegistry(); jobs.push(registry);
  // The grandchild inherits pipes after the parent exits, exercising the existing 200ms grace.
  const script = `process.stdout.write(${JSON.stringify(path + "\n")});require('child_process').spawn(process.execPath,['-e',"setTimeout(()=>{},3000)"],{stdio:'inherit'});process.exit(0)`;
  const { id } = registry.start({command: process.execPath, args: ["-e", script], cwd: root,
    isWindows: false, killTree: defaultKillTree, signal: abort.signal, outputConsumer: sink});
  const record = registry.get(id)!;
  try { await record.done; expect(record.outputError).toBe("checker output pipes did not close completely"); expect(sink.touchedFileListed).toBe(false); }
  finally { record.killGroup(); abort.abort(); }
  expect(await readFile(join(root, "tärgét.ts"), "utf8")).toBe("export const x = 1;\n");
}, 10000);
