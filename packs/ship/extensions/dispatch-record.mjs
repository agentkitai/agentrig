import { spawn } from "node:child_process";
import { assignedFindings, operativeLines } from "../scripts/review-ledger.mjs";
import { createMergeGuard } from "./merge-guard.mjs";
import { createLedgerHook } from "./ledger-integrity.mjs";
import { hasVerdictBlock } from "../scripts/review-verdict.mjs";
import { findingHeadings } from "../scripts/review-finding-index.mjs";

// Date.parse checks the time/zone but normalizes e.g. February 31. Validate
// the written calendar date separately, without UTC conversion changing its day.
function validRepairTimestamp(timestamp) {
  const [year, month, day] = timestamp.slice(0, 10).split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number.isFinite(Date.parse(timestamp));
}

function repairIntent(task) {
  // Round zero and ledger setup prose are initial-build context, not repairs.
  // Detect positive numerators even with damaged punctuation/denominators or split lines;
  // strict standalone receipt validation below must still refuse those tasks.
  return /Repair round\b[^\p{L}\d]*0*[1-9]\d*|Pre-dispatch read-back\b/iu.test(task)
    || (/\bOLD\s+[a-f0-9]{40}\b/iu.test(task) && assignedFindings(operativeLines(task)).length > 0);
}

// Framework hook exceptions/timeouts fail open. Own all failures and finish five
// seconds before that deadline. Never retry a write whose outcome is ambiguous.
export function createDispatchHook({ gh = "gh", git = "git", budgetMs = 25_000, rowForSession = () => undefined, resumePrForSession = () => undefined, isResumeForSession = () => false, prePrBranchForSession = () => undefined, onDispatch = () => {} } = {}) {
  const absenceProofs = new Map();
  return async context => {
    if (context.spawn) {
      // The resolved envelope, not tool spelling/input or ambient session metadata,
      // is the authority for dispatch. Keep the legacy comparison/record body intact.
      context = { ...context, sessionId: context.spawn.parent,
        tool: { name: "subagent", input: { task: context.spawn.task } } };
    } else {
      if (context.tool?.name !== "subagent") return createLedgerHook({ gh, budgetMs })(context);

    }
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
      const pinned = resumePrForSession(context.sessionId);
      const prePrBranch = prePrBranchForSession(context.sessionId);
      const prePr = pinned === null && typeof prePrBranch === "string" && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$/u.test(prePrBranch);
      const proof = absenceProofs.get(context.sessionId);
      if (!prePr || proof?.row !== row || proof?.branch !== prePrBranch) absenceProofs.delete(context.sessionId);
      if (prePrBranch !== undefined && !prePr) throw new Error("invalid pre-PR resume binding");
      if (pinned !== undefined && (!row || (!prePr && (!Number.isSafeInteger(pinned) || pinned <= 0)))) throw new Error("invalid host resume PR binding");
      let prs;
      if (pinned !== undefined && !prePr) {
        // A resumed host mints a fresh marker but explicitly pins the existing PR.
        // Resolve that identity directly, never infer it from candidate PR bodies.
        const pr = JSON.parse(await command(gh, ["pr", "view", String(pinned), "--json", "number,state,headRefName,headRefOid,body,url"]));
        if (!pr || pr.number !== pinned || pr.state !== "OPEN") throw new Error("pinned resume PR is missing, closed or mismatched");
        prs = [pr];
      } else {
        // Enumerate the repository connection directly: search-index emptiness is not
        // evidence of absence. A full bounded page denies rather than hiding a PR.
        const response = JSON.parse(await command(gh, ["pr", "list", "--state", "open", "--json", "number,headRefName,headRefOid,body,url", "--limit", "100"]));
        if (!Array.isArray(response) || response.length >= 100) throw new Error("invalid or truncated PR lookup response");
        if (response.some(pr => !pr || typeof pr.body !== "string" || typeof pr.headRefName !== "string" || !pr.headRefName || !Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[a-f0-9]{40}$/u.test(pr.headRefOid))) throw new Error("invalid PR lookup entry");
        prs = row ? response.filter(pr => typeof pr.body === "string" && pr.body.split(/\r?\n/u).includes(row)) : response.filter(pr => pr.headRefName === branch);
        // Only explicit pre-PR recovery may resume without a pinned PR. The
        // fresh host marker cannot identify historical markers, so conservatively
        // refuse any train-marked open PR rather than guess which row owned it.
        if (row && isResumeForSession(context.sessionId)) {
          if (!prePr) throw new Error("resumed row requires explicit resume.pr or pre-PR resume with pr: null and branch");
          if (absenceProofs.has(context.sessionId) && prs.length > 0) {
            // Only after this session proved absence may its newly created PR
            // use the unchanged fresh host marker. Keep the builder branch exact.
            if (prs.length !== 1 || prs[0].headRefName !== prePrBranch) throw new Error("ambiguous or mismatched pre-PR transition");
          } else {
            if (response.some(pr => pr.headRefName === prePrBranch || /agentrig-train-row:/u.test(pr.body))) throw new Error("pre-PR resume cannot prove absence: open branch or train-marked PR; set explicit resume.pr");
            prs = [];
          }
        }
      }
      if (!Array.isArray(prs)) throw new Error("invalid PR lookup response");
      if (prs.length === 0) {
        if (typeof context.tool.input?.task === "string" && repairIntent(context.tool.input.task)) throw new Error("repair intent requires a live PR and standalone Repair round / Pre-dispatch read-back receipts");
        if (prePr && row && context.sessionId) absenceProofs.set(context.sessionId, { row, branch: prePrBranch });
        return { action: "continue" };
      }
      if (prs.length !== 1) throw new Error("ambiguous PR for current branch");
      const pr = prs[0];
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || (!row && pr.headRefName !== branch) || !/^[a-f0-9]{40}$/u.test(pr.headRefOid)) throw new Error("invalid PR identity/head");
      const input = context.tool.input;
      if (!input || typeof input.task !== "string" || !input.task || !context.sessionId) throw new Error("missing task or parent session id");
      if (input.label !== undefined) throw new Error("omit subagent label: immutable spawn must preserve the complete task");
      const errors = [], checked = [];
      const lines = operativeLines(input.task);
      const rounds = lines.filter(line => /^Repair round:/u.test(line));
      // Intent is deliberately broader than parsing: inline/quoted examples must
      // never turn an attempted repair into an unchecked ordinary dispatch.
      const repair = repairIntent(input.task);
      if (repair) {
        const round = rounds.length === 1 ? /^Repair round: ([1-9]\d*)\/([1-9]\d*)$/u.exec(rounds[0]) : null;
        const readbacks = lines.filter(line => /^Pre-dispatch read-back:/u.test(line));
        const readback = readbacks.length === 1 ? /^Pre-dispatch read-back: Repair round: ([1-9]\d*)\/([1-9]\d*); blockers ([^;]+); OLD ([a-f0-9]{40}); verified (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/u.exec(readbacks[0]) : null;
        const number = Number(round?.[1]), cap = Number(round?.[2]);
        if (!round || !readback || readback[1] !== round[1] || readback[2] !== round[2]
          || !Number.isSafeInteger(number) || !Number.isSafeInteger(cap) || number > cap
          || (number <= 3 ? cap !== 3 : cap !== number) || !readback[3].trim() || !validRepairTimestamp(readback[5])) {
          errors.push("malformed repair intent: put Repair round: N/3 and Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <40-character SHA>; verified <ISO timestamp> on separate standalone lines (use N/N above 3 with a recorded human amendment)");
        }
        const live = JSON.parse(await command(gh, ["pr", "view", String(pr.number), "--json", "number,headRefOid,url,body"]));
        if (live.number !== pr.number || !/^[a-f0-9]{40}$/.test(live.headRefOid) || typeof live.url !== "string") throw new Error("invalid live repair PR");
        if (number > 3) {
          // The PR ledger records human authority, not the child task. Require
          // an exact round-bound record; a bare larger denominator is no grant.
          const prefix = `Human amendment: Repair round: ${number}/${cap}; authorization: `;
          const amendments = typeof live.body === "string" ? operativeLines(live.body).filter(line => line.startsWith(prefix)) : [];
          let authorization;
          try { if (amendments.length === 1) authorization = JSON.parse(amendments[0].slice(prefix.length)); } catch { /* deny below */ }
          if (typeof authorization !== "string" || !authorization.trim()) errors.push(`missing recorded human amendment on PR for Repair round: ${number}/${cap}; record ${prefix}<JSON-quoted verbatim human authorization> in the PR body`);
          else checked.push(`checked human amendment: Repair round: ${number}/${cap}; authorization: ${JSON.stringify(authorization)}`);
        }
        const olds = [...lines.join("\n").matchAll(/\bOLD\s+([a-f0-9]{40})\b/g)].map(match => match[1]);
        if (!olds.length || olds.some(old => old !== live.headRefOid)) errors.push("OLD head does not match live PR head");
        pr.headRefOid = live.headRefOid;
        const headings = assignedFindings(lines);
        if (!headings.length) errors.push("repair task has no exact finding headings");
        for (const { heading, urls } of headings) {
          if (!urls.length) errors.push(`missing source for heading: ${heading}`);
          for (const url of urls) {
            const match = /^(https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+)#(issuecomment-|discussion_r|pullrequestreview-)(\d+)$/.exec(url);
            if (!match || match[1] !== live.url) { errors.push(`unsupported or wrong-PR source: ${url}`); continue; }
            const endpoint = match[3] === "issuecomment-" ? "issues/comments" : match[3] === "discussion_r" ? "pulls/comments" : `pulls/${pr.number}/reviews`;
            const source = JSON.parse(await command(gh, ["api", `repos/${match[2]}/${endpoint}/${match[4]}`]));
            if (String(source.id) !== match[4] || typeof source.body !== "string" || source.html_url !== url) throw new Error(`invalid source response: ${url}`);
            checked.push(`checked source: ${url}; comment ID: ${source.id}; heading: ${heading}`);
            const canonical = hasVerdictBlock(source.body)
              ? findingHeadings(source.body)
              : source.body.split(/\r?\n/u);
            if (!canonical.includes(heading)) errors.push(`missing verbatim heading in ${url}: ${heading}`);
          }
        }
      }
      const comparison = repair ? `Pre-edit comparison: ${errors.length ? "FAIL" : "PASS"}\nlive PR head: ${pr.headRefOid}\n${checked.join("\n")}\n${errors.map(error => `mismatch: ${error}`).join("\n")}\n\n` : "";
      const body = `## AgentRig hook dispatch record\ndispatch time: ${new Date().toISOString()}\nhead SHA: ${pr.headRefOid}\nparent session id: ${context.sessionId}\ntask UTF-8 bytes: ${Buffer.byteLength(input.task)}\n\n${comparison}${input.task}`;
      const posted = JSON.parse(await command(gh, ["api", "repos/{owner}/{repo}/issues/" + pr.number + "/comments", "--method", "POST", "--input", "-"], JSON.stringify({ body })));
      if (!Number.isSafeInteger(posted.id) || posted.id <= 0) throw new Error("missing posted comment id");
      const readback = JSON.parse(await command(gh, ["api", "repos/{owner}/{repo}/issues/comments/" + posted.id]));
      if (typeof readback.body !== "string" || !Buffer.from(readback.body).equals(Buffer.from(body))) throw new Error("comment API read-back byte mismatch");
      if (errors.length) throw new Error(errors.join("; "));
      await onDispatch({ spawn: context.spawn, pr, recordId: posted.id, recordBody: body });
      return { action: "continue" };
    } catch (error) {
      return { action: "deny", reason: `dispatch record failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

export function activate(ctx, { gh = "gh", git = "git", budgetMs = 25_000 } = {}) {
  const rows = new Map();
  const initial = new Set();
  const authorities = new Map();
  const pending = new Map();
  const grants = new Map();
  const key = spawn => JSON.stringify({ parent: spawn.parent, task: spawn.task, role: spawn.role });
  const resumePrs = new Map();
  const resumes = new Map();
  const prePrBranches = new Map();
  // The host embeds this instruction line in the initial prompt; only the PR
  // body binding is on its own line (packages/core/src/train.ts).
  // Remember it per session so conductors on main resolve the builder's PR.
  ctx.hooks.on("user_prompt", context => {
    const first = !initial.has(context.sessionId);
    initial.add(context.sessionId);
    const matches = [...(context.prompt?.matchAll(/^Include this exact host-generated row binding on its own line in the PR body: (agentrig-train-row:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\r?$/gmu) ?? [])];
    if (matches.length === 1) {
      rows.set(context.sessionId, matches[0][1]);
      // Read only the host's adjacent single-line JSON row. Invalid explicit pins
      // are remembered as invalid so the dispatch gate denies instead of failing open.
      try {
        const preceding = context.prompt.slice(0, matches[0].index).trimEnd().split(/\r?\n/u).at(-1);
        if (!preceding?.startsWith("Row: ")) throw new Error("missing host Row");
        const row = JSON.parse(preceding.slice(5));
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid host Row");
        if (first && typeof row.authorization === "string" && row.authorization.trim()) {
          authorities.set(context.sessionId, { authorization: row.authorization, row: matches[0][1] });
        }
        if (row.resume !== undefined && (!row.resume || typeof row.resume !== "object" || Array.isArray(row.resume))) throw new Error("invalid resume");
        resumePrs.set(context.sessionId, row.resume?.pr);
        prePrBranches.set(context.sessionId, row.resume?.branch);
        resumes.set(context.sessionId, row.resume !== undefined);
      } catch {
        prePrBranches.delete(context.sessionId);
        resumes.set(context.sessionId, true);
        resumePrs.set(context.sessionId, null);
      }
    }
    return { action: "continue" };
  });
  const dispatch = createDispatchHook({ gh, git, budgetMs, rowForSession: id => rows.get(id), resumePrForSession: id => resumePrs.get(id), isResumeForSession: id => resumes.get(id), prePrBranchForSession: id => prePrBranches.get(id),
    onDispatch: ({ spawn, pr, recordId, recordBody }) => {
      if (spawn?.role?.name !== "lander") return;
      const authority = authorities.get(spawn.parent);
      if (!authority || typeof pr.url !== "string") throw new Error("lander dispatch requires initial Row.authorization and live PR URL");
      const queue = pending.get(key(spawn)) ?? [];
      queue.push({ ...authority, url: pr.url, recordId, recordBody });
      pending.set(key(spawn), queue);
    },
  });
  const ledger = createLedgerHook({ gh, budgetMs });
  const merge = createMergeGuard({ gh, budgetMs, grantForSession: id => grants.get(id) });
  ctx.hooks.on("post_spawn", context => {
    const spawn = context.spawn;
    if (spawn?.childId && spawn.role?.name === "lander") {
      const queue = pending.get(key(spawn));
      const grant = queue?.shift();
      if (queue?.length === 0) pending.delete(key(spawn));
      if (grant) grants.set(spawn.childId, { ...grant, spawn });
    }
    return { action: "continue" };
  });
  ctx.hooks.on("pre_spawn", dispatch, { timeoutMs: 30_000 });
  ctx.hooks.on("pre_tool", async context => {
    const result = await merge(context);
    return result.action === "deny" ? result : ledger(context);
  }, { timeoutMs: 30_000 });
}
