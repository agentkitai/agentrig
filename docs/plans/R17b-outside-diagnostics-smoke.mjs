// Run after pnpm build: pnpm exec node docs/plans/R17b-outside-diagnostics-smoke.mjs
// POSIX host smoke of the actual default executable on PATH; no live provider or paid calls.
import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { builtinTools, createAgent, RulePolicy, SessionStore } from "../../packages/core/dist/index.js";
import { loadRunConfig } from "../../packages/cli/dist/config.js";

const execFile = promisify(callback);
const require = createRequire(new URL("../../packages/cli/package.json", import.meta.url));
const { Command } = require("commander");
const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-r17b-default-checker-")));
let session;
try {
  const cwd = join(root, "project"), home = join(root, "fixture-home");
  await mkdir(cwd); await mkdir(home);
  const selected = await loadRunConfig(new Command("run"), {}, { cwd, home, env: {} });
  const checker = selected.diagnostics.find(entry => entry.parser === "tsc");
  assert.equal(checker.executable, "tsc");
  assert.equal(checker.maxOutputBytes, 65536);
  assert.deepEqual(checker.args, ["--noEmit", "--pretty", "false", "--listFiles"]);
  await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({compilerOptions: {types: [], skipLibCheck: true, lib: ["es2022"]}, include: ["*.ts"]}));
  for (let i = 0; i < 750; i++) await writeFile(join(cwd, `source_${i}_${"segment".repeat(10)}.ts`), `export const value = ${i};\n`);
  const version = await execFile("tsc", ["--version"], {cwd, timeout: 10000, maxBuffer: 4096});
  const baseline = await execFile(checker.executable, checker.args, {cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024});
  const listingBytes = Buffer.byteLength(baseline.stdout);
  assert.ok(listingBytes > 65536); assert.equal(baseline.stderr, "");
  let calls = 0;
  const provider = {id: "fixture", model: "fake", capabilities: {tools: true, parallelTools: true, caching: false, contextWindow: 100000},
    async *stream() {
      if (calls++ === 0) {
        yield {type: "tool_use", id: "edit", name: "write_file", input: {path: "target.ts", content: 'export const x: number = "bad";'}};
        yield {type: "stop", reason: "tool_use"};
      } else yield {type: "stop", reason: "end_turn"};
    }};
  const store = new SessionStore({root: join(root, "sessions")});
  session = createAgent({provider, store, tools: builtinTools({diagnostics: selected.diagnostics}), systemPrompt: "fixture", repoMap: false,
    permissions: new RulePolicy([{class: "write", decision: "allow"}, {class: "exec", decision: "allow"}])}).run("edit", {cwd});
  await session.done;
  const events = await store.readAll(session.id);
  const invocation = events.find(event => event.type === "tool.call" && event.internal?.kind === "diagnostics");
  assert.deepEqual(invocation.input, {executable: checker.executable, args: checker.args});
  const report = events.find(event => event.type === "tool.result" && event.id === "edit").diagnostics;
  assert.equal(report.status, "reported"); assert.equal(report.exitCode, 2);
  assert.equal(report.entries.length, 1); assert.equal(report.entries[0].code, "TS2322");
  const head = await execFile("git", ["rev-parse", "HEAD"], {cwd: repository});
  const state = await execFile("git", ["status", "--porcelain"], {cwd: repository});
  console.log(JSON.stringify({head: head.stdout.trim(), sourceClean: state.stdout === "", compiler: version.stdout.trim(),
    invocation: invocation.input, listingBytes, diagnosticByteLimit: checker.maxOutputBytes,
    report, fakeProviderCalls: calls, paidProviderCalls: 0,
    scope: "actual default checker selection and executable on PATH; explicit fixture permissions, not full TUI/E1 acceptance"}, null, 2));
} finally {
  if (session) { session.control.abort(); await session.done; }
  await rm(root, {recursive: true, force: true});
}
