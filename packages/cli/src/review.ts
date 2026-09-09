import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { sanitizeLine, type ModelProvider, type PermissionPolicy, type PermissionRequest, type AuxiliaryReport } from "@agentkitai/agentrig-core";
import { TrajectoryReviewer, diffLocations, type DiffReviewOutput } from "@agentkitai/agentrig-supervisor";
import { buildRoleProvider, type ProviderOptions } from "./provider.js";
import { buildPermissionPolicy } from "./run.js";
import { reviewProcess, type ReviewProcess } from "./review-process.js";
import { GitHubPr as Pr, gitHubRequest } from "./github-report.js";
import { captureLocalDiff, LocalDiffRefusal } from "./local-diff.js";

export interface ReviewOptions extends ProviderOptions {
  base?: string; pr?: string; comment?: boolean; sandbox?: string;
  allow?: string[]; deny?: string[]; allowCommand?: string[][]; yolo?: boolean; dangerouslySkipPermissions?: boolean;
  maxTokensPerTurn?: string; maxMinutes?: string;
  maxTokens?: string; maxUsd?: string;
}
class ReviewRefusal extends Error {}
export function reviewFailure(error: unknown): string {
  return error instanceof ReviewRefusal || error instanceof LocalDiffRefusal ? error.message : "diff review refused or failed; no validated result (check bounds, permissions, identity and provider configuration)";
}
export interface ReviewDependencies {
  process?: ReviewProcess;
  provider?: () => ModelProvider;
  policy?: PermissionPolicy;
  ask?: (request: PermissionRequest, signal: AbortSignal) => Promise<"allow" | "deny">;
  onUsage?: (report: AuxiliaryReport) => void;
}
export interface ReviewResult { identity: string; coverage: string; review: DiffReviewOutput; usage?: AuxiliaryReport; commented: boolean }
export function reviewArguments(text: string): Pick<ReviewOptions, "base" | "pr" | "comment"> {
  if (text.length > 512) throw new ReviewRefusal("review arguments exceed limit");
  const words = text.trim() ? text.trim().split(/\s+/) : [];
  const result: Pick<ReviewOptions, "base" | "pr" | "comment"> = {};
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "--comment" && result.comment === undefined) result.comment = true;
    else if ((word === "--base" || word === "--pr") && words[index + 1] !== undefined) {
      const key = word === "--base" ? "base" : "pr";
      if (result[key] !== undefined) throw new ReviewRefusal("duplicate review option");
      result[key] = words[++index]!;
    } else throw new ReviewRefusal("usage: /review [--base ref | --pr n] [--comment]");
  }
  return result;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const safe = (text: string) => sanitizeLine(text, 8192).replace(/\r?\n/g, " ");
export function renderReview(result: ReviewResult): string[] {
  return ["Advisory diff review — not approval or test evidence", `Identity: ${result.identity}`, `Coverage: ${result.coverage}`,
    safe(result.review.summary), ...result.review.findings.map(f => `${safe(f.path)}:${f.line} (${f.side}, ${f.severity}) ${safe(f.message)}`),
    ...(result.review.findings.length ? [] : ["No issues identified in this limited diff; correctness is not established."]),
    ...(result.commented ? ["Posted one explicit PR comment."] : [])];
}

export async function reviewChanges(cwd: string, options: ReviewOptions, parent: AbortSignal,
  dependencies: ReviewDependencies = {}): Promise<ReviewResult> {
  if (options.maxTokens !== undefined || options.maxUsd !== undefined)
    throw new ReviewRefusal("diff review cannot enforce configured total-session maxTokens/maxUsd; select a review profile without these caps and use supported maxMinutes/maxTokensPerTurn limits instead. No provider call or comment was made.");
  if ((options.sandbox ?? "none") !== "none") throw new ReviewRefusal("review host git/gh requires --sandbox none (including under YOLO)");
  if (options.base !== undefined && options.pr !== undefined) throw new ReviewRefusal("review accepts --base or --pr, not both");
  if (options.comment === true && options.pr === undefined) throw new ReviewRefusal("--comment requires --pr");
  if (options.pr !== undefined && !/^[1-9][0-9]{0,8}$/.test(options.pr)) throw new ReviewRefusal("--pr requires a positive PR number");
  if (options.base !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9_./~^{}-]{0,255}$/.test(options.base))) throw new ReviewRefusal("unsupported base ref spelling");
  const maxTokens = Math.min(2048, Number(options.maxTokensPerTurn ?? 2048));
  const timeout = Math.min(90_000, Number(options.maxMinutes ?? 1.5) * 60_000);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || !Number.isFinite(timeout) || timeout < 1) throw new ReviewRefusal("invalid review budget");
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(new DOMException("review timed out", "TimeoutError")), timeout);
  const process = dependencies.process ?? reviewProcess;
  const policy = dependencies.policy ?? buildPermissionPolicy(options);
  let usage: AuxiliaryReport | undefined;
  try {
    signal.throwIfAborted();
    const root = await realpath(cwd);
    const cancellable = async <T>(work: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let cancel!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      try { return await Promise.race([Promise.resolve().then(work), aborted]); }
      finally { signal.removeEventListener("abort", cancel); }
    };
    const permit = async (tool: string, cls: PermissionRequest["class"], args: string[]) => {
      signal.throwIfAborted();
      const request: PermissionRequest = { tool, class: cls, cwd: root, paths: [root], input: { argv: [...args] } };
      let decision = await cancellable(() => policy.decide(request));
      if (decision === "ask") decision = await cancellable(async () => await dependencies.ask?.(request, signal) ?? "deny");
      signal.throwIfAborted();
      if (decision !== "allow") throw new ReviewRefusal(`review ${cls} permission denied`);
    };
    const invoke = async (program: "git" | "gh", args: string[], maxBytes = 16_384, input?: string) => {
      if (program === "gh") return gitHubRequest(args, { cwd: root, signal, process,
        authorize: (permission, argv) => permit("review_gh", permission, argv) }, maxBytes, input);
      await permit("review_git", "read", args);
      const result = await process(program, args, { cwd: root, signal, maxBytes, ...(input === undefined ? {} : { input }) });
      signal.throwIfAborted();
      if (Buffer.byteLength(result) > maxBytes) throw new Error("review capture exceeds byte limit");
      return result;
    };
    const git = (args: string[]) => invoke("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args]);
    let patch: string, identity: string, coverage: string, repo: string | undefined;
    let verify: () => Promise<void>;
    if (options.pr !== undefined) {
      const metadata = async () => Pr.parse(JSON.parse(await invoke("gh", ["pr", "view", options.pr!, ...(repo ? ["--repo", repo] : []), "--json", "number,baseRefOid,headRefOid,url"])));
      const first = await metadata();
      if (String(first.number) !== options.pr) throw new Error("PR identity mismatch");
      repo = first.url.split("/").slice(3, 5).join("/");
      patch = await invoke("gh", ["pr", "diff", options.pr, "--repo", repo, "--color", "never"]);
      identity = `${repo}#${options.pr} ${first.baseRefOid}..${first.headRefOid} sha256:${digest(patch)}`;
      coverage = "Captured PR text diff only; no checkout, other source inspection or tests.";
      verify = async () => { if (JSON.stringify(await metadata()) !== JSON.stringify(first)) throw new Error("PR changed during review; result refused"); };
      await verify();
    } else {
      ({ patch, identity, coverage, verify } = await captureLocalDiff(root, git, options.base));
    }
    diffLocations(patch);
    if (!patch) return { identity, coverage, review: { summary: "No tracked text changes to review.", findings: [] }, commented: false };
    const provider = dependencies.provider?.() ?? buildRoleProvider(options, "supervisor");
    const reviewer = new TrajectoryReviewer({ provider, maxTokens, onUsage: report => {
      usage = report; dependencies.onUsage?.(report);
    } });
    const review = await reviewer.reviewDiff({ patch, identity }, { signal, limits: { timeoutMs: Math.ceil(timeout) } });
    await verify(); signal.throwIfAborted();
    const result: ReviewResult = { identity, coverage, review, ...(usage === undefined ? {} : { usage }), commented: false };
    if (options.comment === true) {
      if (usage === undefined || usage.calls.length !== 1 || usage.calls.some(call => !call.usageComplete || call.outcome !== "completed"))
        throw new Error("incomplete review accounting; comment refused");
      await verify();
      await invoke("gh", ["pr", "comment", options.pr!, "--repo", repo!, "--body-file", "-"], 16_384,
        renderReview(result).join("\n\n"));
      result.commented = true;
    }
    return result;
  } finally { clearTimeout(timer); }
}
