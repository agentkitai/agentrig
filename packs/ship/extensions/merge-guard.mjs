import { shellIntentParts, shellWrapper } from "./shell-intent.mjs";
import { execFile } from "node:child_process";
import { z } from "zod";
import { words } from "./ledger-integrity.mjs";

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const pull = z.object({ number: z.number().int().positive(), url: z.string().url(), state: z.literal("OPEN"), body: z.string(), headRefOid: sha });
const required = z.array(z.object({ name: z.string().min(1), bucket: z.literal("pass"), state: z.literal("SUCCESS") })).min(1);
const runs = z.object({ total_count: z.number().int().nonnegative().max(100), check_runs: z.array(z.object({ name: z.string(), head_sha: sha, status: z.string(), conclusion: z.string().nullable() })) });
const statuses = z.object({ sha, total_count: z.number().int().nonnegative().max(100), statuses: z.array(z.object({ context: z.string(), state: z.string() })) });

// Preserve shell word boundaries: quoted prose is one data argument, not a
// sequence of executable words. This remains a bounded recognizer, not a shell.
export function mergeIntent(command) {
  if (typeof command !== "string") return false;
  const { segments, substitutions } = shellIntentParts(command);
  if (substitutions.some(mergeIntent)) return true;
  return segments.some(args => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "pr" && args[i + 1] === "merge") {
        // Only this invocation's literal help flag exempts it. A flag after
        // -- is positional data; another shell segment never exempts a merge.
        const rest = args.slice(i + 2);
        const help = arg => arg === "--help" || arg === "-h";
        const targets = rest.filter(arg => !help(arg));
        // Do not mistake the value of --subject/--body/etc. for a help flag.
        // Only the bounded help-only form (plus one explicit target) is exempt.
        if (!rest.some(help) || targets.length > 1 || targets.some(arg => !/^[1-9]\d*$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/u.test(arg))) return true;
      }
      if ((args.includes("api") || args.some(arg => /^(?:.*\/)?curl$/u.test(arg))) && /^\S*\bpulls\/[^\s/]+\/merge$/u.test(args[i])) return true;
    }
    // Quoted shell programs and API mutation payloads are executable data,
    // unlike quoted comment/printf text. Retain the previous bounded backstop.
    if (shellWrapper(args)) {
      if (args.some(arg => /\s/u.test(arg) && mergeIntent(arg))) return true;
    }
    if (args.some(arg => /^(?:.*\/)?(?:python[\d.]*|node|ruby|perl)$/u.test(arg))) {
      // These payloads are programs, not shell words. Retain conservative
      // literal recognition without claiming to interpret those languages.
      if (args.some(arg => /\bpr\s+merge\b|\bpulls\/[^\s/]+\/merge\b|\bmergePullRequest\b/u.test(arg))) return true;
    }
    return (args.includes("api") || args.some(arg => /^(?:.*\/)?curl$/u.test(arg))) && args.some(arg => /\bmergePullRequest\b/u.test(arg));
  });
}

// Like ledger edits, merges must be a literal, stand-alone gh invocation. This
// is a tool gate, not a shell sandbox: arbitrary scripts are outside its parser.
export function mergeTarget(command) {
  const args = words(command, "merge guard").flatMap(word => /^-[RXfF]./u.test(word) && !word.startsWith("--") ? [word.slice(0, 2), word.slice(2)] : [word]);
  if (!/^(?:.*\/)?gh$/u.test(args.shift() ?? "")) throw new Error("merge must invoke a single literal gh command");
  const option = (names) => {
    const values = [];
    for (let i = 0; i < args.length; i++) for (const name of names) {
      if (args[i] === name) values.push(args[i + 1]);
      else if (args[i].startsWith(name + "=")) values.push(args[i].slice(name.length + 1));
    }
    if (values.length > 1 || values.some(value => !value || value.startsWith("-"))) throw new Error("ambiguous merge option");
    return values[0];
  };
  const repo = option(["--repo", "-R"]);
  if (repo && !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Error("invalid merge repository");
  if (["--repo", "-R"].includes(args[0])) args.splice(0, 2);
  else if (/^(?:--repo|-R)=/u.test(args[0] ?? "")) args.shift();
  if (args[0] === "pr" && args[1] === "merge") {
    const target = args[2];
    if (!/^[1-9]\d*$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/u.test(target ?? "")) throw new Error("merge requires an explicit PR number or URL");
    if (args.some(arg => /^(?:--auto|--disable-auto|--admin)(?:=|$)/u.test(arg))) throw new Error("deferred or branch-protection-bypassing merge flags are not allowed");
    return { target, repo, head: sha.parse(option(["--match-head-commit"])) };
  }
  if (args[0] === "api") {
    const method = option(["-X", "--method"]);
    const fields = args.some(arg => /^(?:--input|--field|--raw-field)(?:=|$)|^-[fF]/u.test(arg));
    if (["GET", "HEAD"].includes(method) || (method === undefined && !fields)) return undefined;
    const endpoint = args.find(arg => /^\/?repos\//u.test(arg));
    const match = /^\/?repos\/([\w.-]+\/[\w.-]+)\/pulls\/([1-9]\d*)\/merge$/u.exec(endpoint ?? "");
    if (!match || method !== "PUT" || option(["--hostname"]) !== undefined || args.some(arg => /^(?:--input|--field|-F)(?:=|$)/u.test(arg))) throw new Error("use explicit REST PUT repos/OWNER/REPO/pulls/NUMBER/merge with -f sha=HEAD");
    const heads = args.flatMap((arg, i) => ["-f", "--raw-field"].includes(arg) && args[i + 1]?.startsWith("sha=") ? [args[i + 1].slice(4)] : arg.startsWith("--raw-field=sha=") ? [arg.slice(16)] : []);
    if (heads.length !== 1) throw new Error("API merge requires one literal sha field");
    return { target: match[2], repo: match[1], head: sha.parse(heads[0]) };
  }
  throw new Error("unsupported merge syntax; use gh pr merge or REST PUT");
}

export function createMergeGuard({ gh = "gh", budgetMs = 25_000, grantForSession = () => undefined } = {}) {
  return async context => {
    if (!["bash", "exec_shell"].includes(context.tool?.name) || !mergeIntent(context.tool.input?.command)) return { action: "continue" };
    const deadline = Date.now() + budgetMs;
    const run = args => new Promise((resolve, reject) => {
      const timeout = deadline - Date.now();
      if (timeout <= 0) return reject(new Error("merge guard deadline exhausted"));
      execFile(gh, args, { cwd: context.cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
    try {
      const target = mergeTarget(context.tool.input.command);
      if (!target) return { action: "continue" };
      const grant = grantForSession(context.sessionId);
      if (!grant || grant.spawn.childId !== context.sessionId || grant.spawn.role?.name !== "lander" || !grant.recordId) throw new Error("caller must be a lander child with a successful dispatch and existing spawn record for this PR");
      const args = ["pr", "view", target.target, ...(target.repo ? ["--repo", target.repo] : []), "--json", "number,url,state,body,headRefOid"];
      const pr = pull.parse(await run(args));
      const identity = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/u.exec(pr.url);
      if (!identity || pr.url !== grant.url || pr.number !== Number(identity[2]) || (target.repo && target.repo !== identity[1]) || (target.target.startsWith("https:") ? target.target !== pr.url : Number(target.target) !== pr.number)) throw new Error("merge target does not match dispatched PR");
      if (typeof grant.authorization !== "string" || !grant.authorization.trim() || !pr.body.split(/\r?\n/u).includes(grant.authorization) || !pr.body.split(/\r?\n/u).includes(grant.row)) throw new Error("PR body must carry the exact Row.authorization quote and row binding");
      const record = z.object({ id: z.number().int().positive(), body: z.string() }).parse(await run(["api", `repos/${identity[1]}/issues/comments/${grant.recordId}`]));
      if (record.id !== grant.recordId || record.body !== grant.recordBody) throw new Error("dispatch record missing or edited; redispatch lander");
      if (target.head !== pr.headRefOid) throw new Error("merge must pin the exact current head");
      const checks = required.parse(await run(["pr", "checks", String(pr.number), "--repo", identity[1], "--required", "--json", "name,bucket,state"]));
      const prefix = `repos/${identity[1]}/commits/${pr.headRefOid}`;
      const checkRuns = runs.parse(await run(["api", `${prefix}/check-runs?per_page=100`]));
      const status = statuses.parse(await run(["api", `${prefix}/status?per_page=100`]));
      if (checkRuns.total_count !== checkRuns.check_runs.length || status.total_count !== status.statuses.length || status.sha !== pr.headRefOid) throw new Error("incomplete or wrong-head CI response");
      for (const check of checks) {
        const matches = checkRuns.check_runs.filter(run => run.name === check.name);
        const contexts = status.statuses.filter(entry => entry.context === check.name);
        if (matches.length + contexts.length !== 1 || matches.some(run => run.head_sha !== pr.headRefOid || run.status !== "completed" || run.conclusion !== "success") || contexts.some(entry => entry.state !== "success")) throw new Error(`required exact-head CI is not green: ${check.name}`);
      }
      const live = pull.parse(await run(args));
      if (live.headRefOid !== pr.headRefOid || live.body !== pr.body || live.url !== pr.url) throw new Error("PR changed during merge verification; retry");
      return { action: "continue" };
    } catch (error) {
      return { action: "deny", reason: `merge guard: ${error instanceof Error ? error.message : String(error)}. Accepted literal form: gh pr merge NUMBER --squash --match-head-commit FULL_HEAD` };
    }
  };
}
