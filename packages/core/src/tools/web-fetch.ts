import { z } from "zod";
import { currentSandboxPolicy, SandboxDeniedError } from "../sandbox.js";
import type { Tool } from "../tool.js";

const MAX_BYTES = 1_048_576;
const MAX_TEXT = 20_000;
const TIMEOUT_MS = 10_000;
const UrlInput = z.object({ url: z.string().min(1).max(4096).refine(value => {
  if (/[\u0000-\u0020\u007f]/.test(value)) return false;
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
  catch { return false; }
}, "URL must be credential-free HTTP(S), without spaces/control characters") }).strict();

export interface WebFetchOutput {
  url: string;
  status: number;
  mediaType: string;
  bytes: number;
  text: string;
  truncated: boolean;
}

/** Bounded lexical text extraction, not a browser/parser, sanitizer, or readability engine. */
function htmlText(html: string): string {
  const pieces: string[] = []; const lower = html.replace(/[A-Z]/g, c => c.toLowerCase()); let i = 0; let suppressed: string | undefined;
  while (i < html.length) {
    if (suppressed !== undefined) {
      // Script/style bodies are raw text: '<' comparisons are not opening tags. Search only
      // for a complete closing-name boundary, advancing monotonically through rejected prefixes.
      const close = lower.indexOf(`</${suppressed}`, i);
      if (close < 0) break;
      const after = close + suppressed.length + 2;
      if (!/[\s/>]/.test(html[after] ?? "")) { i = after; continue; }
      i = close;
    }
    if (html.startsWith("<!--", i)) { const end = html.indexOf("-->", i + 4); i = end < 0 ? html.length : end + 3; continue; }
    if (html[i] !== "<") {
      const end = html.indexOf("<", i); const stop = end < 0 ? html.length : end;
      if (suppressed === undefined) pieces.push(html.slice(i, stop)); i = stop; continue;
    }
    // Scan each tag once, respecting quoted '>' characters. Incomplete tags are omitted.
    let end = i + 1; let quote: string | undefined;
    for (; end < html.length; end++) {
      const c = html[end]!;
      if (quote !== undefined) { if (c === quote) quote = undefined; }
      else if (c === "'" || c === '"') quote = c;
      else if (c === ">") break;
    }
    if (end === html.length) break;
    const token = html.slice(i + 1, end).trimStart(); const closing = token.startsWith("/");
    const match = /^([a-z][a-z0-9]*)\b/i.exec(closing ? token.slice(1).trimStart() : token);
    const name = match?.[1]?.toLowerCase();
    if (suppressed !== undefined) { if (closing && name === suppressed) suppressed = undefined; }
    else if (!closing && (name === "script" || name === "style")) suppressed = name;
    else pieces.push(" ");
    i = end + 1;
  }
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return pieces.join("").replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{1,8});/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? whole;
    const n = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
  }).replace(/\s+/g, " ").trim();
}

export function webFetchTool(): Tool<z.infer<typeof UrlInput>, WebFetchOutput> {
  return {
    name: "web_fetch",
    description: "GET a credential-free HTTP(S) URL. No redirects, cookies, custom headers or search. Only text/plain and text/html; 1 MiB decoded body, 20,000 returned characters, 10 second deadline. HTML extraction is lexical, not browser rendering. Network permission and sandbox network policy are separate; private/internal destinations are not filtered.",
    inputSchema: UrlInput,
    permission: "net",
    effects: "read-only",
    resultSource: "external",
    // Trusted bounded host fetch, gated by the selected network policy; not OS-contained JS.
    sandbox: "compatible",
    async execute(raw, ctx) {
      const input = UrlInput.parse(raw); // direct SDK calls retain the same URL boundary
      ctx.signal.throwIfAborted();
      const policy = currentSandboxPolicy();
      if (policy !== undefined && policy.mode !== "none" && policy.network !== true) {
        throw new SandboxDeniedError("web_fetch requires explicit sandbox network policy");
      }
      const url = new URL(input.url); url.hash = "";
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error("web_fetch 10 second deadline exceeded")), TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, deadline.signal]);
      let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        response = await fetch(url, { method: "GET", redirect: "manual", credentials: "omit", signal,
          headers: { accept: "text/plain, text/html", "user-agent": "agentrig-web-fetch" } });
        if (response.status >= 300 && response.status < 400) throw new Error("web_fetch refuses redirects; request the destination URL explicitly");
        if (!response.ok) throw new Error(`web_fetch HTTP ${response.status}`);
        const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (mediaType !== "text/plain" && mediaType !== "text/html") throw new Error("web_fetch only accepts text/plain or text/html");
        const length = response.headers.get("content-length");
        if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BYTES) throw new Error("web_fetch body exceeds 1 MiB limit");
        reader = response.body?.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0;
        if (reader !== undefined) for (;;) {
          signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("web_fetch decoded body exceeds 1 MiB limit");
          chunks.push(chunk.value);
        }
        signal.throwIfAborted();
        const decoded = new TextDecoder("utf-8").decode(Buffer.concat(chunks, bytes));
        const text = mediaType === "text/html" ? htmlText(decoded) : decoded;
        const truncated = text.length > MAX_TEXT;
        let end = Math.min(text.length, MAX_TEXT);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        const output: WebFetchOutput = { url: url.href, status: response.status, mediaType, bytes, text: text.slice(0, end), truncated };
        return { output, display: `${output.url}\nHTTP ${output.status}; ${mediaType}; ${bytes} decoded bytes${truncated ? "; text truncated at 20,000 characters" : ""}\n${output.text}`, truncated };
      } finally {
        clearTimeout(timer);
        if (reader !== undefined) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else await response?.body?.cancel().catch(() => {});
      }
    },
  };
}
