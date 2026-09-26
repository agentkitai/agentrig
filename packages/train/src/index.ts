import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";


export interface UsageTotals {
  calls: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  /** Priced subset only; null means no priced calls, never free usage. */
  estimatedMicros: number | null; unpricedCalls: number; incompleteCalls: number;
}
export interface RowUsage {
  row: string; totals: UsageTotals; coverageWarnings: string[];
  sessions: Array<{ session: string; builderProvider: string | null; totals: UsageTotals; models: Array<UsageTotals & { provider: string; model: string }> }>;
}

export interface TrainRuntime {
  usage(directory: string): Promise<RowUsage[]>;
  /** Decode a unified assistant message; invalid/non-assistant input returns undefined. */
  assistantText(message: unknown): string | undefined;
}
export type TrainExec = (executable: string, argv: string[], retry?: boolean, testTimeout?: number) => Promise<string>;
export interface TrainStages {
  preCheck(context: { row: TrainRow; root: string; exec: TrainExec; refreshEnvironment(): Promise<void>; options: TrainOptions }): Promise<string>;
  prompt(context: { row: TrainRow; marker: string }): string | Promise<string>;
  receipt: { schema: unknown; parse(value: unknown): { pr: number } };
  verify(context: { row: TrainRow; marker: string; startingBase: string; state: RecordState; persist(): Promise<void>; exec: TrainExec; command: TrainCommand; checkEnv: NodeJS.ProcessEnv; log: string }): Promise<void>;
  /** Optional transport decoration (e.g. a pack's bounded API retry policy). */
  command?(command: TrainCommand): TrainCommand;
}

const text = z.string().min(1).max(16384).refine(value => value.trim().length > 0, "must not be blank");
const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
/** Operator-owned input, not permission approval. The child still applies normal policy. */
export const TrainRowSchema = z.object({
  task: text,
  builderProvider: text.optional(),
  authorization: text,
  scope: z.array(text).min(1).max(100),
  environment: z.object({
    checkout: text.refine(isAbsolute, "checkout must be absolute"),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/u),
    ciWorkflows: z.array(z.string().min(1).max(200)).min(1).max(50),
    sessionRoot: text.refine(isAbsolute, "sessionRoot must be absolute").optional(),
    profile: z.string().regex(/^[A-Za-z0-9_-]+$/u).optional(),
  }).strict(),
  resume: z.object({
    session: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    pr: z.number().int().positive().nullable().optional(),
    branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$/u).optional(),
  }).strict().refine(resume => resume.pr === null ? resume.branch !== undefined : resume.branch === undefined,
    "pre-PR resume requires pr: null and branch; other resumes must omit branch").optional(),
}).strict();
export type TrainRow = z.infer<typeof TrainRowSchema>;
export interface TrainRequest {
  /** Complete environment when provided; do not reintroduce launcher overlays. */
  env?: NodeJS.ProcessEnv;
  executable: string;
  argv: string[];
  cwd: string;
  log: string;
  /** Host-owned validated final-output receipt; never a child write destination. */
  resultPath?: string;
  onSession?: (id: string) => void;
}
export type TrainCommand = (request: TrainRequest) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface TrainStatus { invalidEntries: string[]; queue: number; active: number; done: number; halted: number; usage?: Array<RowUsage & { coverageWarnings: string[] }> | null; usageError?: string; pricingNote?: string }
export interface TrainOptions {
  /** Host-resolved declaration; absence is an error, empty steps executes nothing. */
  projectChecks?: (checkout: string, profile?: string) => Promise<{ bootstrap: string; preflight?: string | undefined; steps: Array<{ name: string; command: string }> } | undefined>;
  /** CLI entrypoint to re-enter the existing headless run path. */
  cli?: string;
  /** Snapshot before CLI profile overlays are applied. */
  launcherEnvironment?: NodeJS.ProcessEnv;
  command?: TrainCommand;
  childEnvironment?: (checkout: string, profile?: string, builderProvider?: string) => Promise<NodeJS.ProcessEnv>;
  status?: (status: TrainStatus) => void;
  sleep?: () => Promise<void>;
  /** Resolve the project-declared Vitest per-test budget after each fast-forward. */
  testTimeout?: (checkout: string, profile?: string) => Promise<number | undefined>;
}
export const TrainStateSchema = z.object({ row: z.string(), phase: z.string(), reason: z.string().nullable(), pr: z.number().int().positive().nullable(), head: sha.nullable(), mergeCommit: sha.nullable(), sessionIds: z.array(z.string()) }).strict();
export type RecordState = z.infer<typeof TrainStateSchema>;
const folders = ["queue", "active", "done", "halted", "logs"] as const;
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function regular(path: string): Promise<void> { if (!(await lstat(path)).isFile()) throw new Error("row/receipt must be a regular non-symlink file"); }
async function json(path: string): Promise<unknown> { await regular(path); if ((await lstat(path)).size > 65536) throw new Error("JSON exceeds 64 KiB"); return JSON.parse(await readFile(path, "utf8")) as unknown; }
async function save(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    created = true;
    await rename(temporary, path);
  } finally { if (created) await rm(temporary, { force: true }); }
}
/** Conservative transport-only retry: assertion/compiler/package failures never qualify. */
function infrastructure(result: { stdout: string; stderr: string }): boolean {
  const output = result.stdout + result.stderr;
  return /\b(?:ECONNRESET|EAI_AGAIN|ETIMEDOUT)\b|Could not resolve host|remote end hung up unexpectedly/u.test(output)
    && !/AssertionError|FAIL |error TS\d|Tests\s+\d+ failed/u.test(output);
}

/** Shared by consumption, crash recovery and read-only accounting. */
function rowName(name: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/u.test(name); }

/** Fail closed on incomplete/mixed reports. Only default-budget test timeouts qualify. */
function vitestTimeoutFiles(result: { stdout: string; stderr: string }): string[] {
  const output = (result.stdout + "\n" + result.stderr).replace(/\x1b\[[0-9;]*m/gu, "");
  if (/AssertionError|error TS\d|Unhandled|Uncaught|(?:^|\n)\s*Errors\s+\d/iu.test(output)) return [];
  const failures = [...output.matchAll(/^\s*FAIL\s+([^\s]+)\s+>[^\n]*\n([\s\S]*?)(?=^\s*FAIL\s|$(?![\s\S]))/gmu)];
  const count = output.match(/(?:^|\n)\s*Tests\s+(\d+) failed\b/u);
  if (failures.length === 0 || Number(count?.[1]) !== failures.length || [...output.matchAll(/^\s*FAIL\s+/gmu)].length !== failures.length) return [];
  const files = new Set<string>();
  for (const failure of failures) {
    const file = failure[1]!; const detail = failure[2]!;
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
      || !/^Error: Test timed out in 5000ms\./mu.test(detail)
      || [...detail.matchAll(/^(?:\w*Error|Error):/gmu)].length !== 1) return [];
    files.add(file);
  }
  return [...files];
}


export function createTrain(runtime: TrainRuntime, stages: TrainStages) {
  const trainUsage = runtime.usage;
  /** A queue transport and evidence gate, not a review/merge decision engine. */
  async function runTrain(directory: string, options: TrainOptions = {}): Promise<"empty" | "halted" | "stopped"> {
    if (options.command === undefined && options.cli === undefined) throw new Error("train requires a CLI entrypoint");
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    for (const folder of folders) {
      const path = join(root, folder); await mkdir(path, { recursive: true });
      if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error(`unsafe train directory: ${folder}`);
    }
    // A crashed lock is deliberately not stolen. Operator reconciles children before removing it.
    await mkdir(join(root, ".lock"));
    const list = async (folder: string) => (await readdir(join(root, folder))).sort();
    const status = async () => {
      options.status?.(await trainStatus(root, options));
    };
    try {
      const command = stages.command?.(options.command ?? trainCommand) ?? options.command ?? trainCommand;
      // Never replay a possibly still-live child or land operation following a crash.
      for (const name of await list("active")) {
        if (!rowName(name)) continue;
        const stem = name.slice(0, -5);
        let prior: RecordState = { row: name, phase: "recovery", reason: null, pr: null, head: null, mergeCommit: null, sessionIds: [] };
        try { prior = TrainStateSchema.parse(await json(join(root, "logs", `${stem}.state.json`))); } catch { /* interrupted before state persisted */ }
        await save(join(root, "logs", `${stem}.halt.json`), { ...prior, row: name, phase: "recovery", reason: "interrupted active row; reconcile child and PR before explicit resume" });
        await rename(join(root, "active", name), join(root, "halted", name));
        await status(); return "halted";
      }
      while (true) {
        if (await exists(join(root, "STOP"))) return "stopped";
        if (await exists(join(root, "PAUSE"))) { await (options.sleep?.() ?? new Promise(r => setTimeout(r, 1000))); continue; }
        const name = (await list("queue"))[0]; if (name === undefined) return "empty";
        if (!rowName(name)) throw new Error("row names must be unique simple .json basenames");
        // Validate only the selected row; full-queue diagnostics are not a dispatch gate.
        try { await validateQueuedRow(join(root, "queue", name), options); }
        catch { await status(); return "halted"; }
        const stem = name.slice(0, -5);
        for (const folder of ["done", "halted"] as const) if (await exists(join(root, folder, name))) throw new Error(`row identity already used: ${name}`);
        const log = join(root, "logs", `${stem}.log`);
        const statePath = join(root, "logs", `${stem}.state.json`);
        const resultPath = join(root, "logs", `${stem}.result.json`);
        const state: RecordState = { row: name, phase: "schema", reason: null, pr: null, head: null, mergeCommit: null, sessionIds: [] };
        await rename(join(root, "queue", name), join(root, "active", name));
        const persist = () => save(statePath, state);
        try {
          await persist();
          const row = TrainRowSchema.parse(await json(join(root, "active", name)));
          state.pr = row.resume?.pr ?? null;
          if (row.resume !== undefined) state.sessionIds.push(row.resume.session);
          const env = row.environment;
          let childEnv = await options.childEnvironment?.(env.checkout, env.profile, row.builderProvider);
          const checkEnv = { ...(options.launcherEnvironment ?? process.env) };
          for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
            if (childEnv?.[key] !== undefined) checkEnv[key] = childEnv[key];
          }
          delete checkEnv.AGENTRIG_CHILD_PROFILE;
          const exec = async (executable: string, argv: string[], retry = false, testTimeout?: number): Promise<string> => {
            await appendFile(log, JSON.stringify({ ts: new Date().toISOString(), phase: state.phase, executable, argv, ...(testTimeout === undefined ? {} : { testTimeout }) }) + "\n");
            let result = await command({ executable, argv, cwd: env.checkout, env: checkEnv, log });
            if (result.code !== 0 && retry && executable === "pnpm" && argv.length === 1 && argv[0] === "test") {
              const files = vitestTimeoutFiles(result);
              if (files.length > 0) {
                await appendFile(log, "Vitest timeout infrastructure retry 1/1; isolated files only\n");
                for (const file of files) {
                  const isolated = ["exec", "vitest", "run", "--no-file-parallelism", file];
                  await appendFile(log, JSON.stringify({ ts: new Date().toISOString(), phase: state.phase, executable, argv: isolated }) + "\n");
                  const rerun = await command({ executable, argv: isolated, cwd: env.checkout, env: checkEnv, log });
                  if (rerun.code !== 0) throw new Error(`isolated Vitest retry failed: ${file}; see row log`);
                }
                return "";
              }
            }
            if (result.code !== 0 && retry && infrastructure(result)) {
              await appendFile(log, "infrastructure retry 1/1\n");
              result = await command({ executable, argv, cwd: env.checkout, env: checkEnv, log });
            }
            if (result.code !== 0) throw new Error(`${executable} ${argv[0]} exited ${result.code}; see row log`);
            return result.stdout.trim();
          };
          state.phase = "checkout"; await persist();
          const startingBase = await stages.preCheck({ row, root, exec, refreshEnvironment: async () => { childEnv = await options.childEnvironment?.(env.checkout, env.profile, row.builderProvider); }, options });
          state.phase = "run"; await persist();
          if (await exists(resultPath)) throw new Error("stale result receipt; use a new row id for resume");
          const marker = `agentrig-train-row:${randomUUID()}`;
          const schemaPath = join(root, "logs", `${stem}.output-schema.json`);
          await save(schemaPath, stages.receipt.schema);
          const prompt = await stages.prompt({ row, marker });
          const argv = ["run", "--headless", "--json", "--output-schema", schemaPath, "--root", env.sessionRoot ?? join(root, "logs", "sessions")];
          // Validation uses this resolved child profile; run loads it from argv, not the marker.
          const profile = env.profile ?? childEnv?.AGENTRIG_CHILD_PROFILE;
          if (profile !== undefined) argv.push("--profile", profile);
          if (row.resume !== undefined) argv.push("--resume", row.resume.session);
          if (row.builderProvider !== undefined) argv.push("--builder-provider", row.builderProvider);
          argv.push(prompt);
          let sessionWrites = Promise.resolve();
          const result = await command({ executable: process.execPath, argv: options.cli === undefined ? argv : [options.cli, ...argv], cwd: env.checkout, ...(childEnv === undefined ? {} : { env: childEnv }), log, resultPath,
            onSession: id => {
              if (!state.sessionIds.includes(id)) {
                state.sessionIds.push(id);
                const snapshot = { ...state, sessionIds: [...state.sessionIds] };
                sessionWrites = sessionWrites.then(() => save(statePath, snapshot));
              }
            } }).finally(() => sessionWrites);
          await persist();
          if (await exists(resultPath)) {
            const receipt = stages.receipt.parse(await json(resultPath));
            if (row.resume?.pr != null && row.resume.pr !== receipt.pr) throw new Error("resume receipt changed pinned PR");
            state.pr = receipt.pr;
          } else if (result.code === 0) throw new Error("child did not supply validated final PR output");
          if (result.code !== 0) throw new Error(`headless row exited ${result.code}`);
          if (state.pr === null) throw new Error("child did not identify a PR");
          state.phase = "landing"; await persist();
          await stages.verify({ row, marker, startingBase, state, persist, exec, command, checkEnv, log });
          state.phase = "done"; await persist();
          await rename(join(root, "active", name), join(root, "done", name));
        } catch (error) {
          state.reason = error instanceof Error ? error.message : String(error);
          await save(join(root, "logs", `${stem}.halt.json`), state);
          await rename(join(root, "active", name), join(root, "halted", name));
          await status(); return "halted";
        }
        await status();
      }
    } finally { await rm(join(root, ".lock"), { recursive: true }); }
  }

  /** No shell interpolation, no permission bypass; inherit the operator's normal run configuration. */
  const trainCommand: TrainCommand = async request => {
    const inherited = request.env ?? process.env;
    const env = { ...inherited, GIT_TRACE2_EVENT: "0", PATH: (inherited["PATH"] ?? "").split(delimiter).filter(part => !/[\\/]\.git-ai[\\/]bin[\\/]?$/u.test(part)).join(delimiter) };
    return new Promise((resolveResult, reject) => {
      const child = spawn(request.executable, request.argv, { cwd: request.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", pending = "";
      let finalText: string | undefined;
      let validated = false;
      const eventLine = (line: string) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const session = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }).safeParse(event);
          if (session.success) request.onSession?.(session.data.sessionId);
          if (event["type"] === "message.append") {
            finalText = runtime.assistantText(event["message"]);
            validated = false;
          }
          if (event["type"] === "output.validated") validated = event["valid"] === true;
        } catch { /* non-JSON output is never a receipt */ }
      };
      let writes = Promise.resolve();
      const receive = (chunk: Buffer, error: boolean) => {
        const text = chunk.toString();
        writes = writes.then(() => appendFile(request.log, text));
        if (error) stderr = (stderr + text).slice(-1048576); else stdout = (stdout + text).slice(-1048576);
        if (!error && (request.onSession !== undefined || request.resultPath !== undefined)) {
          pending += text;
          for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            eventLine(line);
          }
          if (pending.length > 1048576) pending = "";
        }
      };
      child.stdout.on("data", (chunk: Buffer) => receive(chunk, false));
      child.stderr.on("data", (chunk: Buffer) => receive(chunk, true));
      child.on("error", reject);
      child.on("close", code => { void writes.then(async () => {
        if (pending !== "") eventLine(pending);
        if (code === 0 && request.resultPath !== undefined && validated && finalText !== undefined) {
          let receipt: unknown;
          try {
            receipt = JSON.parse(finalText) as unknown;
            stages.receipt.parse(receipt);
          } catch { receipt = undefined; /* fail closed: no receipt */ }
          // Persist the validated wire value: a custom parser need not accept its normalized output.
          if (receipt !== undefined) await save(request.resultPath, receipt);
        }
        resolveResult({ code: code ?? 1, stdout, stderr });
      }).catch(reject); });
    });
  };

  async function validateQueuedRow(path: string, options: Pick<TrainOptions, "childEnvironment" | "testTimeout">): Promise<void> {
    const row = TrainRowSchema.parse(await json(path));
    await options.childEnvironment?.(row.environment.checkout, row.environment.profile, row.builderProvider);
    z.number().int().min(1).max(120_000).optional().parse(await options.testTimeout?.(row.environment.checkout, row.environment.profile));
  }

  async function trainStatus(directory: string, options: Pick<TrainOptions, "childEnvironment" | "testTimeout"> = {}): Promise<TrainStatus> {
    const invalidEntries: string[] = [];
    const counts = await Promise.all(folders.slice(0, 4).map(async folder => { const entries = await readdir(join(directory, folder)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
      invalidEntries.push(...entries.filter(name => !rowName(name)).map(name => `${folder}/${name}`));
      if (folder === "queue") for (const name of entries.filter(rowName)) {
        try {
          await validateQueuedRow(join(directory, folder, name), options);
        } catch (error) { invalidEntries.push(`${folder}/${name}: ${String(error)}`); }
      }
      return [folder, entries.length];
    }));
    const status = { ...Object.fromEntries(counts), invalidEntries: invalidEntries.sort() } as unknown as TrainStatus;
    try { return { ...status, usage: await trainUsage(directory), pricingNote: "Configured-rate estimates only; ChatGPT-login calls remain unpriced. Raw tokens are reported." }; }
    catch (error) { return { ...status, usage: null, usageError: String(error) }; }
  }

  return { runTrain, trainStatus, trainUsage, trainCommand };
}
