import { spawn } from "node:child_process";

// Framework hook exceptions/timeouts fail open. Own all failures and finish five
// seconds before that deadline. Never retry a write whose outcome is ambiguous.
export function createDispatchHook({ gh = "gh", git = "git", budgetMs = 25_000, rowForSession = () => undefined } = {}) {
  return async context => {
    if (context.tool?.name !== "subagent") return { action: "continue" };
    const deadline = Date.now() + budgetMs;
    const run = (executable, args, input) => new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new Error("25s deadline exhausted"));
      const child = spawn(executable, args, { cwd: context.cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("25s deadline exhausted; dispatch denied")); }, remaining);
      child.on("error", error => finish(error));
      for (const [stream, append] of [[child.stdout, chunk => { stdout += chunk; }], [child.stderr, chunk => { stderr += chunk; }]]) {
        stream.setEncoding("utf8"); stream.on("data", chunk => { append(chunk); if (stdout.length + stderr.length > 1024 * 1024) { child.kill("SIGKILL"); finish(new Error("command output limit exceeded")); } });
      }
      child.stdin.on("error", error => finish(error));
      child.on("close", code => finish(undefined, { code, stdout, stderr }));
      child.stdin.end(input);
    });
    const command = async (executable, args, input) => {
      for (;;) {
        const result = await run(executable, args, input);
        if (result.code === 0) return result.stdout;
        const text = result.stderr + "\n" + result.stdout;
        if (executable !== gh || !/(?:HTTP(?:\/\d+(?:\.\d+)?)?\s+429|rate limit|secondary rate|abuse detection)/iu.test(text)) throw new Error(text || `command exited ${result.code}`);
        const retry = text.match(/^\s*retry-after:\s*(.+)$/imu)?.[1]?.trim();
        const reset = text.match(/^\s*x-ratelimit-reset:\s*(\d+)\s*$/imu)?.[1];
        const delay = retry !== undefined ? (/^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : reset ? Number(reset) * 1000 - Date.now() : 60_000;
        // #538 semantics: honor server metadata, conservative secondary-limit
        // fallback. Unlike the train's 5m budget this hook must deny promptly.
        const wait = Math.max(1000, delay);
        if (!Number.isFinite(wait) || Date.now() + wait + 1000 >= deadline) throw new Error("GitHub rate limit exceeds dispatch hook deadline; retry dispatch later");
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    };
    try {
      const branch = (await command(git, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (!branch || branch === "HEAD") throw new Error("cannot resolve current branch");
      const row = rowForSession(context.sessionId);
      // Enumerate the repository connection directly: search-index emptiness is not
      // evidence of absence. A full bounded page denies rather than hiding a PR.
      const response = JSON.parse(await command(gh, ["pr", "list", "--state", "open", ...(row ? [] : ["--head", branch]), "--json", "number,headRefName,headRefOid,body", "--limit", "100"]));
      if (!Array.isArray(response) || response.length >= 100) throw new Error("invalid or truncated PR lookup response");
      if (response.some(pr => !pr || typeof pr.body !== "string")) throw new Error("invalid PR lookup entry");
      const prs = row ? response.filter(pr => typeof pr.body === "string" && pr.body.split(/\r?\n/u).includes(row)) : response;
      if (!Array.isArray(prs)) throw new Error("invalid PR lookup response");
      if (prs.length === 0) return { action: "continue" };
      if (prs.length !== 1) throw new Error("ambiguous PR for current branch");
      const pr = prs[0];
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || (!row && pr.headRefName !== branch) || !/^[a-f0-9]{40}$/u.test(pr.headRefOid)) throw new Error("invalid PR identity/head");
      const input = context.tool.input;
      if (!input || typeof input.task !== "string" || !input.task || !context.sessionId) throw new Error("missing task or parent session id");
      if (input.label !== undefined) throw new Error("omit subagent label: immutable spawn must preserve the complete task");
      const body = `## AgentRig hook dispatch record\ndispatch time: ${new Date().toISOString()}\nhead SHA: ${pr.headRefOid}\nparent session id: ${context.sessionId}\ntask UTF-8 bytes: ${Buffer.byteLength(input.task)}\n\n${input.task}`;
      const posted = JSON.parse(await command(gh, ["api", "repos/{owner}/{repo}/issues/" + pr.number + "/comments", "--method", "POST", "--input", "-"], JSON.stringify({ body })));
      if (!Number.isSafeInteger(posted.id) || posted.id <= 0) throw new Error("missing posted comment id");
      const readback = JSON.parse(await command(gh, ["api", "repos/{owner}/{repo}/issues/comments/" + posted.id]));
      if (typeof readback.body !== "string" || !Buffer.from(readback.body).equals(Buffer.from(body))) throw new Error("comment API read-back byte mismatch");
      return { action: "continue" };
    } catch (error) {
      return { action: "deny", reason: `dispatch record failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

export function activate(ctx) {
  const rows = new Map();
  // The host embeds this instruction line in the initial prompt; only the PR
  // body binding is on its own line (packages/core/src/train.ts).
  // Remember it per session so conductors on main resolve the builder's PR.
  ctx.hooks.on("user_prompt", context => {
    const matches = [...(context.prompt?.matchAll(/^Include this exact host-generated row binding on its own line in the PR body: (agentrig-train-row:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\r?$/gmu) ?? [])];
    if (matches.length === 1) rows.set(context.sessionId, matches[0][1]);
    return { action: "continue" };
  });
  ctx.hooks.on("pre_tool", createDispatchHook({ rowForSession: id => rows.get(id) }), { timeoutMs: 30_000 });
}
