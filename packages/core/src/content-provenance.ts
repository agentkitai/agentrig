import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ContentBlock, ContentTrust, Message } from "./messages.js";
import type { AnyTool } from "./tool.js";
import { ADVISORY_CONTEXT, combinedContext } from "./context-principals.js";

/** Source join, not an authorization ranking. Unknown ancestry must not become trusted. */
export function joinContentTrust(blocks: readonly ContentBlock[]): ContentTrust {
  let trust: ContentTrust = "user";
  if (blocks.length === 0) return "external";
  for (const block of blocks) {
    if (block.trust !== "user" && block.trust !== "project") return "external";
    if (block.trust === "project") trust = "project";
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const nested = joinContentTrust(block.content);
      if (nested === "external") return nested;
      if (nested === "project") trust = nested;
    }
  }
  return trust;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Capture both sides of a file read; races with non-cooperating writers are not attested. */
export async function prepareResultTrust(tool: AnyTool, input: unknown, cwd: string, root?: string): Promise<() => Promise<ContentTrust>> {
  const source = tool.resultSource;
  if (source === "external") return async () => "external";
  if (source === undefined) return async () => "tool-output";
  try {
    if (root === undefined) return async () => "external";
    const path = resolve(cwd, source.file(input));
    const before = await Promise.all([realpath(root), realpath(cwd), realpath(path)]);
    if (!within(before[0]!, before[1]!) || !within(before[0]!, before[2]!)) return async () => "external";
    return async () => {
      try {
        const after = await Promise.all([realpath(root), realpath(cwd), realpath(path)]);
        return before.every((value, index) => value === after[index]) ? "project" : "external";
      } catch { return "external"; }
    };
  } catch { return async () => "external"; }
}

function structure(block: ContentBlock): unknown {
  const { trust: _trust, context: _context, ...data } = block;
  return data.type === "tool_result" && Array.isArray(data.content)
    ? { ...data, content: data.content.map(structure) } : data;
}

/** Ignore custom output labels. Exact content copies retain source labels, never claimed ones. */
export function retainCompactionTrust(source: Message[], output: Message[]): Message[] {
  const originals = source.flatMap(message => message.content);
  const floor = joinContentTrust(originals);
  const label = (block: ContentBlock, candidates: ContentBlock[]): ContentBlock => {
    const matches = candidates.filter(candidate => isDeepStrictEqual(structure(candidate), structure(block)));
    const trust = matches.length === 1 ? matches[0]!.trust : matches.length > 1 ? joinContentTrust(matches) : floor;
    const context = matches.length === 1 ? matches[0]!.context
      : matches.length > 1 ? combinedContext(matches.map(match => match.context ?? ADVISORY_CONTEXT)) : ADVISORY_CONTEXT;
    const { trust: _claimed, context: _claimedContext, ...data } = block;
    return { ...data, ...(trust === undefined ? {} : { trust }), ...(context === undefined ? {} : { context }),
      ...(data.type === "tool_result" && Array.isArray(data.content) ? { content: data.content.map(child => label(child,
        matches.flatMap(candidate => candidate.type === "tool_result" && Array.isArray(candidate.content) ? candidate.content : []))) } : {}) };
  };
  return output.map(message => ({ ...message, content: message.content.map(block => label(block, originals)) }));
}
