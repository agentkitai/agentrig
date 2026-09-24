import { assignedFindings, operativeLines } from "../scripts/review-ledger.mjs";
import { hasVerdictBlock } from "../scripts/review-verdict.mjs";
import { findingHeadings } from "../scripts/review-finding-index.mjs";
import { LedgerPull, LedgerComment, PullPatch } from "../scripts/ledger-schema.mjs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Deliberately not a shell interpreter. Body writes must be a single literal gh
// command; shell expansion, pipelines and stdin cannot be verified before execution.
export function words(command) {
  const out = []; let value = "", quote, active = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = undefined; else value += ch; continue; }
    if (ch === "'" && !quote) { quote = ch; active = true; continue; }
    if (ch === '"') { quote = quote ? undefined : ch; active = true; continue; }
    if (ch === "$" || ch === "`" || (!quote && /[;&|<>\n\r()]/u.test(ch))) throw new Error("use a single literal gh command (no shell expansion or operators) for body edits");
    if (ch === "\\") {
      if (++i >= command.length) throw new Error("incomplete shell escape");
      const next = command[i];
      if (next === "\n") continue;
      // POSIX double quotes preserve backslashes before non-special characters.
      value += quote === '"' && !/[\\$`"\n]/u.test(next) ? "\\" + next : next;
      active = true; continue;
    }
    if (!quote && /\s/u.test(ch)) { if (active) out.push(value); value = ""; active = false; }
    else { value += ch; active = true; }
  }
  if (quote) throw new Error("unclosed shell quote");
  if (active) out.push(value);
  return out;
}
function option(args, names) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const name = names.find(name => args[i] === name || args[i].startsWith(name + "="));
    if (!name) continue;
    const value = args[i] === name ? args[++i] : args[i].slice(name.length + 1);
    if (value === undefined) throw new Error("missing body-edit option value");
    values.push(value);
  }
  if (values.length > 1) throw new Error("ambiguous duplicate body-edit option");
  return values[0];
}
export function ledgerEditIntent(command) {
  if (typeof command !== "string") return false;
  const visible = command.replace(/\\\r?\n/gu, "").replaceAll("'", "").replaceAll('"', "").replace(/\\(?=[a-z])/gu, "");
  return /\bpr\s+edit\b/u.test(visible) || /\bapi\b[\s\S]*\bpulls(?:\/|\b)/u.test(visible);
}
async function candidate(command, cwd) {
  const args = words(command).flatMap(word => /^-[bFRfX]./u.test(word) && !word.startsWith("--") ? [word.slice(0, 2), word.slice(2)] : [word]);
  if (!/^(?:.*\/)?gh$/u.test(args.shift() ?? "")) throw new Error("body edit must invoke literal gh directly");
  const repo = option(args, ["--repo", "-R"]);
  if (repo && !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Error("invalid repository");
  // Global repository flags are accepted before the command as well as after it.
  if (["--repo", "-R"].includes(args[0])) args.splice(0, 2);
  else if (/^(?:--repo|-R)=/u.test(args[0] ?? "")) args.shift();
  const fileBody = async path => {
    if (!path || path === "-") throw new Error("body stdin cannot be checked; use a regular body file");
    const text = await readFile(resolve(cwd, path), "utf8");
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("body file exceeds ledger guard limit");
    return text;
  };
  if (args[0] === "pr" && args[1] === "edit") {
    const body = option(args, ["--body", "-b"]), file = option(args, ["--body-file", "-F"]);
    if (body === undefined && file === undefined) return undefined;
    if (body !== undefined && file !== undefined) throw new Error("ambiguous body and body-file");
    const target = args[2];
    if (!target || !/^\d+$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/u.test(target)) throw new Error("body edit requires an explicit PR number or URL");
    return { target, repo, body: body ?? await fileBody(file) };
  }
  if (args[0] === "api") {
    const method = option(args, ["--method", "-X"]);
    const hasFields = args.some(arg => /^(?:--input|--field|--raw-field)(?:=|$)|^-[fF]$/u.test(arg));
    if ((method === undefined && !hasFields) || method === "GET" || method === "HEAD") return undefined;
    const endpoint = args.find(arg => /^\/?repos\//u.test(arg))?.replace(/^\//u, "");
    const match = /^repos\/([\w.{}-]+\/[\w.{}-]+)\/pulls\/([1-9]\d*)$/u.exec(endpoint ?? "");
    if (!match) {
      // Pull creation, review/comment operations are not edits to a PR's body.
      if (/^repos\/[\w.{}-]+\/[\w.{}-]+\/pulls(?:$|\/(?:[1-9]\d*\/|comments(?:\/|$)))/u.test(endpoint ?? "")) return undefined;
      throw new Error("unsupported pulls API command; use explicit repos/OWNER/REPO/pulls/NUMBER");
    }
    if (match[1].includes("{") && match[1] !== "{owner}/{repo}") throw new Error("partial repository placeholders cannot establish target identity");
    const hostname = option(args, ["--hostname"]);
    if (hostname !== undefined && hostname !== "github.com") throw new Error("unsupported GitHub hostname");
    if (method !== "PATCH") throw new Error("body edit must use explicit PATCH");
    const input = option(args, ["--input"]);
    const fields = args.flatMap((arg, i) => ["-f", "-F", "--field", "--raw-field"].includes(arg) ? [{value: args[i + 1], typed: ["-F", "--field"].includes(arg)}] : /^(?:--field|--raw-field)=/u.test(arg) ? [{value: arg.slice(arg.indexOf("=") + 1), typed: arg.startsWith("--field=")}] : []);
    if (input !== undefined && fields.length) throw new Error("ambiguous PATCH input and fields");
    let body;
    if (input !== undefined) body = PullPatch.parse(JSON.parse(await fileBody(input))).body;
    else {
      const bodies = fields.filter(field => field.value?.startsWith("body="));
      if (bodies.length > 1) throw new Error("duplicate PATCH body");
      body = bodies[0]?.value.slice(5);
      if (bodies[0]?.typed && body?.startsWith("@")) body = await fileBody(body.slice(1));
      else if (bodies[0]?.typed && /^(?:null|true|false|-?\d+)$/u.test(body ?? "")) throw new Error("typed PATCH body must be a string, not a JSON primitive");
    }
    if (body === undefined) return undefined;
    if (typeof body !== "string") throw new Error("PATCH body must be a string");
    return { target: match[2], repo: match[1].includes("{") ? undefined : match[1], body };
  }
  throw new Error("unsupported body-edit syntax");
}

export function createLedgerHook({ gh = "gh", budgetMs = 25_000 } = {}) {
  return async context => {
    if (!["bash", "exec_shell"].includes(context.tool?.name)) return { action: "continue" };
    const command = context.tool.input?.command;
    if (!ledgerEditIntent(command)) return { action: "continue" };
    const deadline = Date.now() + budgetMs;
    const run = args => new Promise((accept, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new Error("ledger fetch deadline exhausted"));
      const child = spawn(gh, args, { cwd: context.cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", error = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("ledger fetch deadline exhausted")); }, remaining);
      child.on("error", e => { clearTimeout(timer); reject(e); });
      child.stdout.on("data", data => { out += data; if (out.length > 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("ledger fetch output limit")); } });
      child.stderr.on("data", data => { error += data; if (error.length > 1024 * 1024) child.kill("SIGKILL"); });
      child.on("close", code => { clearTimeout(timer); code === 0 ? accept(out) : reject(new Error(error || "ledger fetch failed")); });
    });
    try {
      const edit = await candidate(command, context.cwd);
      if (!edit) return { action: "continue" };
      const pr = LedgerPull.parse(JSON.parse(await run(["pr", "view", edit.target, ...(edit.repo ? ["--repo", edit.repo] : []), "--json", "number,url,body"])));
      const identity = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/u.exec(pr.url ?? "");
      if (!identity || pr.number !== Number(identity[2]) || (edit.repo && identity[1] !== edit.repo) || (edit.target.startsWith("https:") ? edit.target !== pr.url : Number(edit.target) !== pr.number) || typeof pr.body !== "string") throw new Error("invalid fetched PR identity/body");
      // Protect the entire body: it is the review ledger, including historical
      // counters, coverage and check receipts outside a named Ledger section.
      if (!edit.body.startsWith(pr.body)) throw new Error("PR body ledger is append-only: retain all existing bytes and append corrections/resolutions");
      const appended = edit.body.slice(pr.body.length);
      const lines = operativeLines(appended);
      const identityLine = line => line.startsWith("Finding identities: ");
      const findings = [
        ...lines.filter(identityLine).flatMap(line => assignedFindings([line])),
        ...assignedFindings(lines.filter(line => !identityLine(line))),
      ];
      // Historical evidence may disappear; refetch only appended references.
      // Reused finding sources remain new references, never subtract historic URLs.
      const urls = new Set(appended.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#(?:issuecomment-|discussion_r|pullrequestreview-)[^\s<>()[\]"'`]+/gu) ?? []);
      for (const finding of findings) for (const url of finding.urls) urls.add(url);
      const sources = new Map();
      for (const url of urls) {
        const parsed = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)#(issuecomment-|discussion_r|pullrequestreview-)(\d+)$/u.exec(url);
        if (!parsed) throw new Error(`malformed source comment URL: ${url}`);
        const [, repo, number, kind, id] = parsed;
        const resource = kind === "issuecomment-" ? "issues/comments" : kind === "discussion_r" ? "pulls/comments" : `pulls/${number}/reviews`;
        const source = LedgerComment.parse(JSON.parse(await run(["api", `repos/${repo}/${resource}/${id}`])));
        if (String(source.id) !== id || source.html_url !== url || typeof source.body !== "string") throw new Error(`source URL does not match fetched comment: ${url}`);
        sources.set(url, source.body);
        if (appended.includes(url) && hasVerdictBlock(source.body) && findingHeadings(source.body).length && !findings.some(finding => finding.urls.includes(url))) throw new Error(`structured source requires exact finding identities: ${url}`);
      }
      for (const { heading, urls: findingUrls } of findings) {
        if (!findingUrls.length) throw new Error(`missing finding source: ${heading}`);
        for (const url of findingUrls) {
          const body = sources.get(url);
          if (body === undefined) throw new Error(`unfetched finding source: ${url}`);
          const canonical = hasVerdictBlock(body) ? findingHeadings(body) : body.split(/\r?\n/u);
          if (!canonical.includes(heading)) throw new Error(`non-verbatim finding identity at ${url}: ${JSON.stringify(heading)}`);
        }
      }
      return { action: "continue" };
    } catch (error) { return { action: "deny", reason: `ledger integrity failed: ${error.message}` }; }
  };
}
