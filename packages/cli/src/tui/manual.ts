import { realpath } from "node:fs/promises";
import { sanitizeLine, type PermissionPolicy, type PermissionRequest, type SessionStore } from "@agentkitai/agentrig-core";
import { diagnose, type DoctorOptions } from "../doctor.js";
import { captureLocalDiff, gitRevision } from "../local-diff.js";
import { reviewProcess, type ReviewProcess } from "../review-process.js";

export function boundedManualLines(lines: string[]): string[] {
  const result: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const safe = sanitizeLine(line, 512);
    bytes += Buffer.byteLength(safe) + 1;
    if (result.length >= 120 || bytes > 32_768) { result.push("[display excerpt: remaining output omitted]"); break; }
    result.push(safe);
  }
  return result;
}

export async function manualDoctor(options: DoctorOptions, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  if (options.cli?.sandbox !== undefined && options.cli.sandbox !== "none")
    throw new Error("/doctor host diagnostics require sandbox none; no probe was started");
  const result = await diagnose({ ...options, cli: { ...options.cli, probe: false } });
  signal.throwIfAborted();
  return boundedManualLines(["Doctor — local configuration checks only; no provider probe. Filesystem probes are joined, not forcibly cancellable.", ...result.lines]);
}

export async function manualDiff(cwd: string, args: string, signal: AbortSignal, options: {
  sandbox?: string; policy: PermissionPolicy; store: SessionStore; session?: string;
  ask?: (request: PermissionRequest, signal: AbortSignal) => Promise<"allow" | "deny">;
  process?: ReviewProcess;
}): Promise<string[]> {
  if ((options.sandbox ?? "none") !== "none") throw new Error("/diff host Git requires sandbox none");
  if (args !== "" && !/^checkpoint(?: [1-9][0-9]{0,8})?$/.test(args)) throw new Error("usage: /diff [checkpoint [turn]]");
  const root = await realpath(cwd);
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const cancellable = async <T>(work: () => Promise<T> | T): Promise<T> => {
    boundedSignal.throwIfAborted();
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(boundedSignal.reason);
      boundedSignal.addEventListener("abort", cancel, { once: true });
      if (boundedSignal.aborted) cancel();
    });
    try { return await Promise.race([Promise.resolve().then(work), aborted]); }
    finally { boundedSignal.removeEventListener("abort", cancel); }
  };
  const git = async (args: string[]) => {
    boundedSignal.throwIfAborted();
    const request: PermissionRequest = { tool: "diff_git", class: "read", cwd: root, paths: [root], input: { argv: args } };
    let decision = await cancellable(() => options.policy.decide(request));
    if (decision === "ask") decision = await cancellable(() => options.ask?.(request, boundedSignal) ?? "deny");
    boundedSignal.throwIfAborted();
    if (decision !== "allow") throw new Error("/diff read permission denied");
    const text = await (options.process ?? reviewProcess)("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { cwd: root, signal: boundedSignal, maxBytes: 16_384 });
    if (Buffer.byteLength(text) > 16_384) throw new Error("/diff capture exceeds bounds");
    boundedSignal.throwIfAborted();
    return text;
  };
  let base: string | undefined;
  if (args !== "") {
    if (options.session === undefined) throw new Error("no selected checkpoint conversation");
    const events = await options.store.materialize(options.session);
    if (events.at(-1)?.type !== "session.end") throw new Error("checkpoint diff requires a closed conversation");
    const turn = args.split(" ")[1];
    const checkpoint = events.filter(event => event.type === "checkpoint.created" && (turn === undefined || event.turn === Number(turn))).at(-1);
    if (checkpoint?.type !== "checkpoint.created" || checkpoint.ref !== `refs/agentrig/${checkpoint.sessionId}/${checkpoint.turn}`)
      throw new Error("no matching recorded checkpoint");
    const after = events.slice(events.indexOf(checkpoint) + 1);
    const boundary = after.findIndex(event => event.sessionId === checkpoint.sessionId &&
      (event.type === "session.end" || event.type === "session.start" || event.type === "session.resume"));
    if (boundary < 0 || after[boundary]?.type !== "session.end") throw new Error("checkpoint run is unverified");
    const seal = after.slice(0, boundary).find(event => event.type === "checkpoint.sealed" &&
      event.sessionId === checkpoint.sessionId && event.seq > checkpoint.seq && event.turn >= checkpoint.turn &&
      event.ref === `refs/agentrig/${checkpoint.sessionId}/sealed/${event.turn}`);
    if (seal?.type !== "checkpoint.sealed" || await realpath(seal.repo) !== root) throw new Error("checkpoint repository is unverified");
    const verify = async () => {
      const ref = (await git(["for-each-ref", "--format=%(symref) %(objectname)", checkpoint.ref])).trimEnd();
      if (ref === "") throw new Error(`checkpoint turn ${checkpoint.turn} is unavailable (pruned or missing); only the last two mutating-turn refs are retained`);
      if (ref !== ` ${checkpoint.commit}` || await gitRevision(git, checkpoint.ref) !== checkpoint.commit ||
        (await git(["rev-parse", "--verify", "--end-of-options", `${checkpoint.commit}^{tree}`])).trim() !== checkpoint.tree)
        throw new Error("checkpoint ref/object changed");
    };
    await verify(); base = checkpoint.commit;
    const captured = await captureLocalDiff(root, git, base, true);
    await verify();
    return boundedManualLines([`Checkpoint ${checkpoint.turn}; ${captured.identity}`, captured.coverage, ...(captured.patch ? captured.patch.split("\n") : ["No tracked changes."])]);
  }
  const captured = await captureLocalDiff(root, git);
  return boundedManualLines([captured.identity, captured.coverage, ...(captured.patch ? captured.patch.split("\n") : ["No tracked changes."])]);
}
