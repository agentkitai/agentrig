import { z } from "zod";
import { reviewProcess, type ReviewProcess } from "./review-process.js";

/** Fixed host-selected GitHub operations; task/model content never becomes argv. */
export const GitHubPr = z.object({ number: z.number().int().positive(),
  baseRefOid: z.string().regex(/^[a-f0-9]{40}$/), headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
  url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/),
}).strict();
export type GitHubPr = z.infer<typeof GitHubPr>;
export interface GitHubTransport {
  cwd: string; signal: AbortSignal; process?: ReviewProcess;
  authorize: (permission: "exec" | "net", args: string[]) => Promise<void>;
}
export function gitHubRepo(pr: GitHubPr): string { return pr.url.split("/").slice(3, 5).join("/"); }
export async function gitHubRequest(args: string[], options: GitHubTransport, maxBytes = 16_384, input?: string): Promise<string> {
  options.signal.throwIfAborted();
  await options.authorize("exec", args); await options.authorize("net", args);
  options.signal.throwIfAborted();
  if (input !== undefined && Buffer.byteLength(input) > 65_536) throw new Error("GitHub report exceeds limit");
  const result = await (options.process ?? reviewProcess)("gh", args, {
    cwd: options.cwd, signal: options.signal, maxBytes, ...(input === undefined ? {} : { input }),
  });
  options.signal.throwIfAborted();
  if (Buffer.byteLength(result) > maxBytes) throw new Error("GitHub response exceeds limit");
  return result;
}
export async function readGitHubPr(number: string, repo: string | undefined, options: GitHubTransport): Promise<GitHubPr> {
  if (!/^[1-9][0-9]{0,8}$/.test(number) || repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("invalid GitHub target");
  const pr = GitHubPr.parse(JSON.parse(await gitHubRequest(["pr", "view", number, ...(repo === undefined ? [] : ["--repo", repo]),
    "--json", "number,baseRefOid,headRefOid,url"], options)));
  if (String(pr.number) !== number || repo !== undefined && gitHubRepo(pr) !== repo) throw new Error("GitHub target mismatch");
  return pr;
}
export async function verifyGitHubPr(pr: GitHubPr, options: GitHubTransport): Promise<void> {
  if (JSON.stringify(await readGitHubPr(String(pr.number), gitHubRepo(pr), options)) !== JSON.stringify(pr))
    throw new Error("GitHub PR identity changed");
}
export async function postGitHubReport(pr: GitHubPr, body: string, options: GitHubTransport): Promise<void> {
  await verifyGitHubPr(pr, options);
  await gitHubRequest(["pr", "comment", String(pr.number), "--repo", gitHubRepo(pr), "--body-file", "-"], options, 16_384, body);
}
