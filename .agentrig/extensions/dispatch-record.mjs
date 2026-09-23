import { spawn } from "node:child_process";
import { hasVerdictBlock } from "../../scripts/review-verdict.mjs";
import { findingHeadings } from "../../scripts/review-finding-index.mjs";

// Protocol fields are operative lines, not occurrences in quoted history or examples.
// Keep every remaining byte: heading whitespace/Markdown is identity, not decoration.
function operativeLines(task) {
  let fence;
  return task.split(/\r?\n/u).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return "";
    }
    if (marker) { fence = marker; return ""; }
    return /^\s*>/u.test(line) ? "" : line;
  });
}

function assignedFindings(lines) {
  const legacy = new Set(findingHeadings(lines.join("\n")));
  const sources = lines.map(line => [...line.matchAll(/https:\/\/github\.com\/[^\s<>`\)]+/gu)].map(match => match[0].replace(/:$/u, "")));
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const explicit = /^(?:[A-Z]\d+ heading: |Finding: )(.*)$/u.exec(line);
    // Existing ship tasks also paste a raw heading followed by Source: URL.
    // No severity grammar applies to that heading, including schema headings.
    const beforeSource = /^Source: https:\/\/github\.com\//u.test(lines[index + 1] ?? "")
      && line.length && !sources[index].length && !/^(?:Repair round:|Pre-dispatch read-back:)/u.test(line);
    const heading = explicit ? explicit[1] : legacy.has(line) || beforeSource ? line : undefined;
    if (heading !== undefined && heading.trim()) headings.push({ heading, index });
  }
  return headings.map((entry, i) => {
    // A named source-first group starts a new association, not a trailing source
    // for the last heading of the previous reviewer.
    const following = sources.slice(entry.index, headings[i + 1]?.index ?? lines.length)
      .flatMap((urls, offset) => /^.+ source https:\/\//iu.test(lines[entry.index + offset]) ? [] : urls);
    // Source-first groups (e.g. Claude source URL; C1 heading: ...; C2 heading: ...).
    const preceding = sources.slice(0, entry.index).findLast(urls => urls.length) ?? [];
    return { ...entry, urls: following.length ? following : preceding };
  });
}

function repairIntent(task) {
  return /Repair round\b|Pre-dispatch read-back\b/iu.test(task)
    || (/\bOLD\s+[a-f0-9]{40}\b/iu.test(task) && assignedFindings(operativeLines(task)).length > 0);
}

// Framework hook exceptions/timeouts fail open. Own all failures and finish five
// seconds before that deadline. Never retry a write whose outcome is ambiguous.
export function createDispatchHook({ gh = "gh", git = "git", budgetMs = 25_000, rowForSession = () => undefined, resumePrForSession = () => undefined, isResumeForSession = () => false } = {}) {
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
      const pinned = resumePrForSession(context.sessionId);
      if (pinned !== undefined && (!row || !Number.isSafeInteger(pinned) || pinned <= 0)) throw new Error("invalid host resume PR binding");
      let prs;
      if (pinned !== undefined) {
        // A resumed host mints a fresh marker but explicitly pins the existing PR.
        // Resolve that identity directly, never infer it from candidate PR bodies.
        const pr = JSON.parse(await command(gh, ["pr", "view", String(pinned), "--json", "number,state,headRefName,headRefOid,body"]));
        if (!pr || pr.number !== pinned || pr.state !== "OPEN") throw new Error("pinned resume PR is missing, closed or mismatched");
        prs = [pr];
      } else {
        // Enumerate the repository connection directly: search-index emptiness is not
        // evidence of absence. A full bounded page denies rather than hiding a PR.
        const response = JSON.parse(await command(gh, ["pr", "list", "--state", "open", "--json", "number,headRefName,headRefOid,body", "--limit", "100"]));
        if (!Array.isArray(response) || response.length >= 100) throw new Error("invalid or truncated PR lookup response");
        if (response.some(pr => !pr || typeof pr.body !== "string" || typeof pr.headRefName !== "string" || !pr.headRefName || !Number.isSafeInteger(pr.number) || pr.number <= 0 || !/^[a-f0-9]{40}$/u.test(pr.headRefOid))) throw new Error("invalid PR lookup entry");
        prs = row ? response.filter(pr => typeof pr.body === "string" && pr.body.split(/\r?\n/u).includes(row)) : response.filter(pr => pr.headRefName === branch);
        // A resumed row has an existing association to establish, unlike an
        // initial builder. Never guess from the checkout or an old row marker.
        if (row && isResumeForSession(context.sessionId) && prs.length === 0) throw new Error("resumed row has no verified PR association; add the fresh row marker to the PR body or set explicit resume.pr");
      }
      if (!Array.isArray(prs)) throw new Error("invalid PR lookup response");
      if (prs.length === 0) {
        if (typeof context.tool.input?.task === "string" && repairIntent(context.tool.input.task)) throw new Error("repair intent requires a live PR and standalone Repair round / Pre-dispatch read-back receipts");
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
          || (number <= 3 ? cap !== 3 : cap !== number) || !readback[3].trim() || !Number.isFinite(Date.parse(readback[5]))) {
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
      return { action: "continue" };
    } catch (error) {
      return { action: "deny", reason: `dispatch record failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

export function activate(ctx) {
  const rows = new Map();
  const resumePrs = new Map();
  const resumes = new Map();
  // The host embeds this instruction line in the initial prompt; only the PR
  // body binding is on its own line (packages/core/src/train.ts).
  // Remember it per session so conductors on main resolve the builder's PR.
  ctx.hooks.on("user_prompt", context => {
    const matches = [...(context.prompt?.matchAll(/^Include this exact host-generated row binding on its own line in the PR body: (agentrig-train-row:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\r?$/gmu) ?? [])];
    if (matches.length === 1) {
      rows.set(context.sessionId, matches[0][1]);
      // Read only the host's adjacent single-line JSON row. Invalid explicit pins
      // are remembered as invalid so pre_tool denies instead of failing open.
      try {
        const preceding = context.prompt.slice(0, matches[0].index).trimEnd().split(/\r?\n/u).at(-1);
        if (!preceding?.startsWith("Row: ")) throw new Error("missing host Row");
        const row = JSON.parse(preceding.slice(5));
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid host Row");
        if (row.resume !== undefined && (!row.resume || typeof row.resume !== "object" || Array.isArray(row.resume))) throw new Error("invalid resume");
        resumePrs.set(context.sessionId, row.resume?.pr);
        resumes.set(context.sessionId, row.resume !== undefined);
      } catch {
        resumePrs.set(context.sessionId, null);
      }
    }
    return { action: "continue" };
  });
  ctx.hooks.on("pre_tool", createDispatchHook({ rowForSession: id => rows.get(id), resumePrForSession: id => resumePrs.get(id), isResumeForSession: id => resumes.get(id) }), { timeoutMs: 30_000 });
}
