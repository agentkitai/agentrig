import { open, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AnyTool, ToolContext, ToolResult } from "./tool.js";
import { contentHash } from "./session-store.js";
import { sandboxSpawnInvocation } from "./sandbox-providers.js";
import { JobRegistry } from "./tools/background-jobs.js";
import { defaultKillTree } from "./tools/bash.js";
import { DiagnosticsConfigSchema, type DiagnosticChecker, type Diagnostics, type DiagnosticsConfig } from "./diagnostics-types.js";
import { TscDiagnosticOutput, TSC_DIAGNOSTIC_LINE } from "./diagnostic-output.js";

// Only the real factories call these internal seams. Names, copied output and persisted data
// cannot activate a checker or attest to changed bytes. Trusted SDK JavaScript is not sandboxed.
const builtins = new WeakSet<object>();
const configured = new WeakMap<object, DiagnosticChecker[]>();
interface Changed { path: string; contentHash: string; unverifiable?: true }
const changes = new WeakMap<object, { context: ToolContext; changed: Changed }>();
const enabledContexts = new WeakSet<object>();
export function diagnosticContext(context: ToolContext): void { enabledContexts.add(context); }
export function diagnosticBuiltin<T extends AnyTool>(tool: T): T { builtins.add(tool); return tool; }
export function configureDiagnostics(tools: AnyTool[], config: DiagnosticsConfig | undefined): void {
  if (config === undefined) return;
  const entries = DiagnosticsConfigSchema.parse(config);
  for (const tool of tools) if (builtins.has(tool)) configured.set(tool, entries);
}
export function hasDiagnostics(tool: AnyTool): boolean { return (configured.get(tool)?.length ?? 0) > 0; }
export async function stampChanged(result: ToolResult, context: ToolContext, path: string, text: string): Promise<void> {
  if (!enabledContexts.has(context)) return;
  try { changes.set(result, { context, changed: Object.freeze({ path: await realpath(path), contentHash: contentHash(text) }) }); }
  catch { changes.set(result, { context, changed: Object.freeze({ path: resolve(context.cwd, path), contentHash: contentHash(text), unverifiable: true }) }); }
}
export function takeChanged(tool: AnyTool, result: ToolResult, context: ToolContext): { changed: Changed; checker: DiagnosticChecker } | undefined {
  const receipt = changes.get(result); changes.delete(result);
  if (receipt?.context !== context) return undefined;
  const checker = configured.get(tool)?.find(c => c.extensions.includes(extname(receipt.changed.path).toLowerCase()));
  return checker === undefined ? undefined : { changed: receipt.changed, checker: { ...checker, args: checker.args.map(arg => arg === "{path}" ? receipt.changed.path : arg) } };
}
export async function unchanged(changed: Changed): Promise<boolean> {
  if (changed.unverifiable) return false;
  let file;
  try {
    if (await realpath(changed.path) !== changed.path) return false;
    file = await open(changed.path, "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return false;
    const bytes = Buffer.alloc(info.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytesRead === info.size && contentHash(bytes.subarray(0, bytesRead).toString("utf8")) === changed.contentHash;
  } catch { return false; } finally { await file?.close(); }
}

interface Observed { text: string; exitCode: number | null; incomplete: boolean; aborted: boolean; partialSafe: boolean; reason: string; sameCommand: boolean; touchedFileListed?: boolean }
export function checkerTool(checker: DiagnosticChecker, changedPath: string): { tool: AnyTool; input: unknown; observed: () => Observed | undefined; id: string; join: () => Promise<void> } {
  let observed: Observed | undefined;
  let settled = Promise.resolve();
  const input = { executable: checker.executable, args: checker.args };
  const expectedCommand = structuredClone(input);
  const tool: AnyTool = {
    name: "core:diagnostics", description: "Internal configured post-edit checker", permission: "exec", sandbox: "compatible",
    inputSchema: z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(32) }).strict()
      .refine(v => ![v.executable, ...v.args].some(s => /[\u0000-\u001f\u007f]/.test(s)) && Buffer.byteLength(JSON.stringify(v)) <= 16_384, "invalid argv"),
    async execute(actual, ctx) {
      const invocation = sandboxSpawnInvocation(actual.executable, actual.args, ctx.cwd);
      const registry = new JobRegistry();
      ctx.signal.throwIfAborted();
      const sameCommand = isDeepStrictEqual(actual, expectedCommand);
      const deadline = new AbortController();
      const sink = sameCommand && checker.parser === "tsc" && checker.args.includes("--listFiles")
        ? new TscDiagnosticOutput(changedPath, checker.maxOutputBytes, AbortSignal.any([ctx.signal, deadline.signal])) : undefined;
      const job = registry.start({ command: invocation.command, args: invocation.args, cwd: ctx.cwd,
        isWindows: process.platform === "win32", killTree: defaultKillTree, signal: ctx.signal,
        maxUnreadBytes: checker.maxOutputBytes, killOnOverflow: true, ...(sink === undefined ? {} : { outputConsumer: sink }) });
      const record = registry.get(job.id)!;
      settled = record.done;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; deadline.abort(); registry.kill(job.id); }, checker.timeoutMs);
      try { await record.done; }
      finally { clearTimeout(timer); registry.disposeAll(); }
      const output = registry.read(job.id)!;
      const reason = ctx.signal.aborted ? "checker aborted" : timedOut ? "checker timed out" : record.spawnError !== undefined
        ? "checker failed to start" : record.outputError ?? (output.droppedBytes > 0 ? "checker output exceeded bound" : record.exitCode === null ? "checker ended without exit status" : "checker completed");
      observed = { text: sink?.text ?? output.output, exitCode: record.exitCode, reason, aborted: ctx.signal.aborted, partialSafe: sink !== undefined,
        incomplete: ctx.signal.aborted || timedOut || record.spawnError !== undefined || record.outputError !== undefined || output.droppedBytes > 0 || record.exitCode === null,
        sameCommand, ...(sink === undefined ? {} : { touchedFileListed: sink.touchedFileListed }) };
      // A completed compiler reporting errors is an observation, not a failed tool dispatch.
      // Its exit remains in diagnostics; ordinary in-progress edits must not trigger error bursts.
      return { output: { exitCode: record.exitCode }, display: `${reason} (exit ${record.exitCode ?? "unknown"})`, isError: observed.incomplete };
    },
  };
  return { tool, input, observed: () => observed, id: `diagnostic-${randomUUID()}`, join: () => settled };
}

const Ruff = z.array(z.object({ filename: z.string(), code: z.string().nullable(), message: z.string(),
  location: z.object({ row: z.number().int().positive(), column: z.number().int().positive() }) }));
export async function diagnosticReport(changed: Changed, checker: DiagnosticChecker, cwd: string, callId: string,
  observed: Observed | undefined): Promise<Diagnostics> {
  const report: Diagnostics = { path: changed.path, contentHash: changed.contentHash, checkerCallId: callId, status: "unavailable", reason: "checker was not executed",
    exitCode: observed?.exitCode ?? null, entries: [], otherFileCount: 0, omitted: 0 };
  if (!await unchanged(changed)) return { ...report, status: "changed", reason: "changed-file bytes could not be verified" };
  if (observed === undefined) return report;
  // Output produced by a command the configured checker never ran is not the checker's evidence.
  if (!observed.sameCommand) return { ...report, status: "incomplete", reason: "checker command changed by hook" };
  // A cancelled turn stops here rather than spending canonicalization on output nobody awaits.
  if (observed.aborted) return { ...report, status: "incomplete", reason: observed.reason };
  // Only the line-bounded sink preserves whole diagnostic records on failure. A raw registry
  // tail can start midway through a filename, falsely attributing another file's error here.
  if (observed.incomplete && !observed.partialSafe) return { ...report, status: "incomplete", reason: observed.reason };
  const entries: Array<{ path: string; line: number; column?: number; code?: string; message: string }> = [];
  let unknown = false;
  // --listFiles is compiler-observed coverage, not a guessed tsconfig traversal.
  // A solution can exit zero without compiling any referenced source files.
  const checksCoverage = checker.parser === "tsc" && checker.args.includes("--listFiles");
  if (checker.parser === "ruff-json") {
    try { for (const d of Ruff.parse(JSON.parse(observed.text))) entries.push({ path: d.filename, line: d.location.row,
      column: d.location.column, ...(d.code === null ? {} : { code: d.code }), message: d.message }); }
    catch { unknown = true; }
  } else for (const line of observed.text.split(/\r?\n/).filter(s => s.trim() !== "")) {
    if (line.length > 8192) { unknown = true; continue; }
    const match = checker.parser === "tsc" ? TSC_DIAGNOSTIC_LINE.exec(line)
      : /^(.+?):(\d+)(?::(\d+))?: (.+)$/.exec(line);
    if (match === null) {
      unknown = true;
      continue;
    }
    const n = Number(match[2]), col = match[3] === undefined ? undefined : Number(match[3]);
    if (!Number.isSafeInteger(n) || n < 1 || (col !== undefined && (!Number.isSafeInteger(col) || col < 1))) { unknown = true; continue; }
    entries.push({ path: match[1]!, line: n, ...(col === undefined ? {} : { column: col }),
      ...(checker.parser === "tsc" ? { code: match[4]!, message: match[5]! } : { message: match[4]! }) });
  }
  let size = 0;
  for (const { path, ...entry } of entries) {
    let canonical: string;
    try { canonical = await realpath(resolve(cwd, path)); } catch { unknown = true; continue; }
    if (canonical !== changed.path) { report.otherFileCount++; continue; }
    const bounded = { ...entry, message: entry.message.slice(0, 1024), ...(entry.code === undefined ? {} : { code: entry.code.slice(0, 64) }) };
    const bytes = Buffer.byteLength(JSON.stringify(bounded));
    if (report.entries.length >= 100 || size + bytes > 12_000) { report.omitted++; continue; }
    size += bytes; report.entries.push(bounded);
    if (entry.message.length > 1024 || (entry.code?.length ?? 0) > 64) unknown = true;
  }
  if (observed.incomplete) {
    // #263: whatever the bounded sink already parsed stays useful, but a run that failed, timed
    // out or overflowed witnesses nothing. Its coverage is unknown and is never called complete.
    report.status = "incomplete";
    report.reason = (report.entries.length > 0 || report.otherFileCount > 0
      ? `${observed.reason} (partial diagnostics retained; coverage not established)` : observed.reason).slice(0, 256);
  } else if (checksCoverage && observed.touchedFileListed !== true) {
    report.status = "incomplete"; report.reason = "checker did not establish touched-file coverage";
  } else if (unknown || report.omitted > 0 || (observed.exitCode !== 0 && entries.length === 0)) {
    report.status = "incomplete"; report.reason = "unrecognized, omitted or unexplained checker output";
  } else { report.status = "reported"; report.reason = report.otherFileCount > 0 ? "checker also reported other-file diagnostics"
    : report.entries.length > 0 ? "checker reported touched-file diagnostics" : "no diagnostics reported (not proof of correctness)"; }
  return report;
}

export function boundDiagnosticReport(report: Diagnostics): Diagnostics {
  let omitted = false;
  if (report.path.length > 4096) { report.path = report.path.slice(0, 4096); omitted = true; }
  while (Buffer.byteLength(JSON.stringify(report)) > 16_000 && report.entries.length > 0) {
    report.entries.pop(); report.omitted++; omitted = true;
  }
  if (Buffer.byteLength(JSON.stringify(report)) > 16_000) { report.path = report.path.slice(0, 1024); omitted = true; }
  if (omitted) { report.status = "incomplete"; report.reason = "diagnostics or path omitted to fit report bound"; }
  return report;
}
