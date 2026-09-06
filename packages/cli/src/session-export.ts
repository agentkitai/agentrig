import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import {
  materializeExportMessages, SessionExportError, SessionStore, validateExportMessage,
  checkExportJsonDepth, type ContentBlock, type Message,
} from "@agentkitai/agentrig-core";

export type ExportFormat = "jsonl" | "sharegpt" | "md";
const PLACEHOLDER = "[redacted]";
const OPAQUE = "[opaque content omitted: explicitly lossy export]";
const OUTPUT_BYTES = 64 * 1024 * 1024;
const REDACT_FILE_BYTES = 64 * 1024;
const SECRET_KEY = /^(?:authorization|proxy[-_]?authorization|(?:access|refresh|id)[-_]?token|(?:[a-z0-9]+[_-])*(?:token|api[-_]?key|secret(?:[-_]?access)?[-_]?key|private[-_]?key|password|passwd|client[-_]?secret)|cookie|set-cookie)$/i;
const WARNING = "Heuristic redaction can miss unknown secrets and remove innocent text. Canonical fields preserve supported materialized messages only; redaction and opaque omission are intentionally lossy. Provenance is data, not authorization.";

/** Bounded key recognition and forward-only value scanning; never rescan every word suffix. */
function redactAssignments(input: string, replaced: () => void): string {
  const prefix = /(?<![A-Za-z0-9_-])(?:["']?([A-Za-z_][A-Za-z0-9_-]{0,255})["']?\s{0,64}[:=]\s{0,64}|--(api-key|token|password|secret)(?:=|\s{1,64}))/gi;
  const parts: string[] = [];
  let copied = 0;
  for (let match = prefix.exec(input); match !== null; match = prefix.exec(input)) {
    if (match[2] === undefined && !SECRET_KEY.test(match[1]!)) continue;
    const start = prefix.lastIndex;
    let end = start;
    const quote = input[start];
    if (input.startsWith(PLACEHOLDER, start)) end += PLACEHOLDER.length;
    else if (quote === '"' || quote === "'") {
      end++;
      while (end < input.length) {
        const char = input[end++];
        if (char === "\\" && end < input.length) end++;
        else if (char === quote) break;
      }
    } else {
      while (end < input.length && !/[\s,;&}\]"']/.test(input[end]!)) end++;
    }
    if (end === start) continue;
    parts.push(input.slice(copied, match.index), PLACEHOLDER);
    copied = end;
    prefix.lastIndex = end;
    replaced();
  }
  parts.push(input.slice(copied));
  return parts.join("");
}

/** Exact literals only, never user regexes or implicit environment/credential enumeration. */
async function readRedactions(path: string | undefined): Promise<string[]> {
  if (path === undefined) return [];
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > REDACT_FILE_BYTES) throw new SessionExportError("redaction file must be a regular file of at most 64 KiB");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.size !== before.size) throw new SessionExportError("redaction file changed while opening");
    const buffer = Buffer.alloc(REDACT_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (size > REDACT_FILE_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.ino !== current.ino || before.mtimeMs !== current.mtimeMs) throw new SessionExportError("redaction file changed or exceeds its bound");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    checkExportJsonDepth(text);
    const values = z.array(z.string().min(1).refine(s => Buffer.byteLength(s) <= 4096)).max(256).safeParse(JSON.parse(text));
    if (!values.success) throw new SessionExportError("redaction file must contain at most 256 nonempty JSON strings of at most 4 KiB each");
    return [...new Set(values.data)].sort((a, b) => b.length - a.length);
  } finally { await handle.close(); }
}

/** Clone first, scrub every arbitrary string (including tool input keys), then render. */
export function redactExportMessages(messages: readonly Message[], literals: readonly string[] = [], omitOpaque = false): { messages: Message[]; redactions: number; omittedOpaque: number } {
  let redactions = 0, omittedOpaque = 0;
  const literalPattern = literals.length === 0 ? undefined : new RegExp([...literals].sort((a,b) => b.length-a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const text = (value: string): string => {
    const replace = (pattern: RegExp): void => { value = value.replace(pattern, () => { redactions++; return PLACEHOLDER; }); };
    if (literalPattern !== undefined) replace(literalPattern);
    replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|$)/g);
    replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi);
    // Scan each candidate once, then validate segments at fixed boundaries. Repeated malformed
    // eyJ prefixes must not trigger quadratic suffix searches on a supported plain-text block.
    value = value.replace(/(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_.-]+/g, candidate => {
      let token = candidate.replace(/\.+$/, "");
      // An unsigned JWT has an empty third segment; preserve that separator while stripping
      // sentence punctuation, rather than missing the credential entirely.
      if (token.indexOf(".") >= 0 && token.indexOf(".") === token.lastIndexOf(".") && token.length < candidate.length) token += ".";
      if (!/^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*$/.test(token)) return candidate;
      redactions++;
      return PLACEHOLDER + candidate.slice(token.length);
    });
    replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g);
    replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]+:[^\s/@]+@/gi);
    // Credential assignments in JSON, env/shell snippets, CLI flags, headers and URL queries.
    value = redactAssignments(value, () => { redactions++; });
    return value;
  };
  const json = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of entries) {
        const safeKey = text(key);
        if (Object.hasOwn(result, safeKey)) throw new SessionExportError("redaction would collide structured field names");
        if (SECRET_KEY.test(key)) { redactions++; result[safeKey] = PLACEHOLDER; }
        else result[safeKey] = json(item);
      }
      return Object.fromEntries(Object.entries(result));
    }
    return value;
  };
  const block = (b: ContentBlock): ContentBlock => {
    const labels = {
      ...(b.trust === undefined ? {} : { trust: b.trust }),
      ...(b.context === undefined ? {} : { context: {
        ...b.context,
        ...(b.context.principal.startsWith("hook:") ? { principal: `hook:${text(b.context.principal.slice(5))}` as const } : {}),
        ...(b.context.delegation === undefined ? {} : { delegation: text(b.context.delegation) }),
      } }),
    };
    switch (b.type) {
      case "text": return { ...b, ...labels, text: text(b.text) };
      case "tool_use": return { ...b, ...labels, id: text(b.id), name: text(b.name), input: json(b.input) };
      case "tool_result": return { ...b, ...labels, toolUseId: text(b.toolUseId), content: typeof b.content === "string" ? text(b.content) : b.content.map(block),
        ...(b.diagnostics === undefined ? {} : { diagnostics: json(b.diagnostics) as NonNullable<typeof b.diagnostics> }) };
      case "image":
        if (!omitOpaque) throw new SessionExportError("opaque image content cannot be inspected; use --omit-opaque for an explicitly lossy export");
        omittedOpaque++;
        return { type: "text", text: OPAQUE, ...labels };
      default: throw new SessionExportError("unsupported export content type");
    }
  };
  const result = structuredClone(messages).map(value => {
    const message = validateExportMessage(value);
    return validateExportMessage({ role: message.role, content: message.content.map(block) });
  });
  return { messages: result, redactions, omittedOpaque };
}

const view = (message: Message): string => message.content.map(block => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
const fence = (text: string): string => {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
};

/** Whole artifact is constructed before any stdout write. No config/provider calls or writes. */
export async function exportSession(store: SessionStore, id: string, options: { format?: string; redactFile?: string; omitOpaque?: boolean; signal?: AbortSignal; outputBytes?: number } = {}): Promise<string> {
  try {
    const format = options.format ?? "jsonl";
    if (format !== "jsonl" && format !== "sharegpt" && format !== "md") throw new SessionExportError("export format must be jsonl, sharegpt or md");
    const outputBytes = options.outputBytes ?? OUTPUT_BYTES;
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > OUTPUT_BYTES) throw new SessionExportError("invalid export output bound");
    const literals = await readRedactions(options.redactFile);
    const source = await materializeExportMessages(store, id, options.signal === undefined ? {} : { signal: options.signal });
    const redacted = redactExportMessages(source, literals, options.omitOpaque);
    const metadata = { version: 1, kind: "agentrig.transcript", warning: WARNING, redactions: redacted.redactions, omittedOpaque: redacted.omittedOpaque };
    let output: string;
    if (format === "jsonl") output = [JSON.stringify(metadata), ...redacted.messages.map(message => JSON.stringify({ kind: "message", message }))].join("\n") + "\n";
    else if (format === "sharegpt") output = JSON.stringify({ agentrig: metadata, conversations: redacted.messages.map(message => ({ from: message.role === "user" ? "human" : "gpt", value: view(message), agentrig: { message } })) }) + "\n";
    else {
      const readable = redacted.messages.map(message => `${message.role.toUpperCase()}\n${view(message)}`).join("\n\n");
      const canonical = JSON.stringify({ agentrig: metadata, messages: redacted.messages });
      const f = fence(readable + canonical);
      output = `# AgentRig transcript v1\n\n${WARNING}\n\n${f}text\n${readable}\n${f}\n\n## Canonical data (not import authority)\n\n${f}agentrig-canonical-v1\n${canonical}\n${f}\n`;
    }
    if (Buffer.byteLength(output) > outputBytes) throw new SessionExportError("session export exceeds the output bound (at most 64 MiB)");
    if (options.signal?.aborted) throw new SessionExportError("session export cancelled");
    return output;
  } catch (error) {
    if (error instanceof SessionExportError) throw error;
    throw new SessionExportError("cannot export session: invalid or unavailable export input");
  }
}
