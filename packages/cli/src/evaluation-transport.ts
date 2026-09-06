import { dirname } from "node:path";
import { evaluatorPaths } from "./evaluation-fixtures.js";

export interface EvaluationProcess {
  code: number | null; infrastructure: boolean; stdout: string; stderr: string; error: string | null;
}
export interface EvaluationWorker { image: string; workspace: string; checkerReceipt?: string }
export interface EvaluationTask { id: string; revision: string; repository: string; prompt: string; allowed: string[] }
export interface EvaluationReceipt {
  version: 1; id: string; runId: string; workspace: string; repository: string;
  revision: string; baseline: string; receiptPath: string;
}
/** Trusted in-process dependency injection is only for SDK fixtures, never a CLI/config option. */
export interface EvaluationTransport {
  task(id: string): Promise<EvaluationTask>;
  command(program: string, args: string[], options?: { cwd?: string; signal?: AbortSignal | undefined; timeout?: number; ownedTree?: boolean }): Promise<EvaluationProcess>;
  worker(options: EvaluationWorker, args: string[], signal: AbortSignal, timeout?: number): Promise<EvaluationProcess>;
  preflight(images: string[], signal?: AbortSignal): Promise<void>;
}

export function evaluationTransport(): EvaluationTransport {
  // Variable URLs deliberately load only these fixed, repository-owned E1/E3 entry points.
  const support = import(evaluatorPaths.support) as Promise<{
    command: EvaluationTransport["command"]; dockerRun: EvaluationTransport["worker"];
  }>;
  const tasks = import(evaluatorPaths.tasks) as Promise<{ taskFor(id: string): EvaluationTask }>;
  return {
    task: async id => (await tasks).taskFor(id),
    command: async (program, args, options) => (await support).command(program, args, options),
    worker: async (options, args, signal, timeout) => (await support).dockerRun(options, args, signal, timeout),
    async preflight(images, signal) {
      if (process.platform !== "linux") throw new Error("isolated evaluation execution currently requires Linux and local Docker images");
      const api = await support;
      const ready = await api.command("docker", ["info", "--format", "{{.OSType}}"], { signal, timeout: 10_000 });
      if (ready.code !== 0 || ready.stdout.trim() !== "linux") throw new Error("evaluation requires an available Linux Docker daemon");
      for (const image of new Set(images)) {
        if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("evaluation image must be pinned by ID");
        const found = await api.command("docker", ["image", "inspect", "--format", "{{.Id}}", image], { signal, timeout: 10_000 });
        if (found.code !== 0 || found.stdout.trim() !== image) throw new Error("evaluation image is not available locally; no image will be pulled");
      }
    },
  };
}

export async function verifyEvaluationSource(transport: EvaluationTransport, source: string, task: EvaluationTask, signal?: AbortSignal) {
  const result = await transport.command("git", ["rev-parse", "--verify", `${task.revision}^{commit}`], { cwd: source, signal, timeout: 10_000 });
  if (result.code !== 0 || result.stdout.trim() !== task.revision)
    throw new Error("evaluation source does not contain the exact pinned task revision");
}

export async function prepareEvaluationWorkspace(transport: EvaluationTransport, task: string, source: string,
  destination: string, signal: AbortSignal): Promise<EvaluationReceipt> {
  const prepared = await transport.command(process.execPath, [evaluatorPaths.workspace, task, source, destination], {
    cwd: dirname(evaluatorPaths.workspace), signal, timeout: 120_000, ownedTree: true,
  });
  if (prepared.code !== 0) throw new Error("evaluation workspace preparation failed; any partial workspace is retained");
  // Read the actual external E1 receipt, not process stdout (which may contain Git diagnostics).
  const { readFile } = await import("node:fs/promises");
  const receipt = JSON.parse(await readFile(`${destination}.receipt.json`, "utf8")) as EvaluationReceipt;
  if (receipt.id !== task || receipt.workspace !== destination || receipt.version !== 1
    || !/^[a-f0-9-]{36}$/.test(receipt.runId) || !/^[a-f0-9]{40}$/.test(receipt.baseline))
    throw new Error("invalid prepared evaluation receipt");
  return { ...receipt, receiptPath: `${destination}.receipt.json` };
}
