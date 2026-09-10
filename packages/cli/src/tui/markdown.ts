import { Marked, type Token, type Tokens } from "marked";
import { common, createLowlight } from "lowlight";
import { markdownTable } from "./viewport.js";

export const MARKDOWN_LIMITS = { source: 32_768, output: 131_072, nodes: 4096, depth: 16, code: 8192 } as const;
const lexer = new Marked({ gfm: true, breaks: false });
const names = ["javascript", "typescript", "python", "go", "rust", "json", "bash", "css", "xml", "sql"];
const highlighter = createLowlight(Object.fromEntries(names.flatMap(name => common[name] ? [[name, common[name]!]] : [])));
type SyntaxNode = ReturnType<typeof highlighter.highlight>["children"][number];
const RESET = "\u001b[0m";
const syntaxStyles: Record<string, number> = { "hljs-keyword": 35, "hljs-string": 32, "hljs-number": 33,
  "hljs-literal": 33, "hljs-comment": 90, "hljs-title": 36, "hljs-built_in": 36, "hljs-type": 36, "hljs-attr": 34 };

/** Text only: never accept source SGR/OSC, even when numeric entities decode to controls. */
export function terminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}
function entities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (raw, entity: string) => {
    if (entity[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? raw;
    const hex = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : raw;
  });
}
function prefix(text: string, cap: number): string {
  let used = 0, result = "";
  for (const char of text) { const size = Buffer.byteLength(char); if (used + size > cap) break; used += size; result += char; }
  return result;
}
function fallback(source: string, reason: string): string {
  return `[Markdown formatting omitted: ${reason}]\n${prefix(terminalText(prefix(source, MARKDOWN_LIMITS.source)), MARKDOWN_LIMITS.source)}\n[bounded literal display; original text retained]`;
}

/** Pure final-answer presentation. No terminal width or global parser configuration is mutated. */
export function renderMarkdown(source: string, columns: number, color = process.env["NO_COLOR"] === undefined, assistantTone?: "white" | "black"): string {
  if (Buffer.byteLength(source) > MARKDOWN_LIMITS.source) return fallback(source, "source exceeds 32 KiB");
  let nodes = 0, bytes = 0;
  const enter = (depth: number) => { if (++nodes > MARKDOWN_LIMITS.nodes || depth > MARKDOWN_LIMITS.depth) throw Error("structure bound"); };
  const checked = (text: string) => { bytes += Buffer.byteLength(text); if (bytes > MARKDOWN_LIMITS.output) throw Error("output bound"); return text; };
  // Ink supplies the surrounding tone once; a renderer-owned reset must restore it.
  // This fixed enum never accepts arbitrary terminal sequences from configuration or Markdown.
  const restore = RESET + (assistantTone === undefined ? "" : `\u001b[${assistantTone === "white" ? 37 : 30}m`);
  const paint = (text: string, styles: number[] = [], decode = true) => {
    const safe = terminalText(decode ? entities(text) : text);
    return checked(color && styles.length && safe ? `\u001b[${styles.join(";")}m${safe}${restore}` : safe);
  };
  const syntax = (items: SyntaxNode[], depth: number, styles: number[] = []): string => items.map(node => {
    enter(depth);
    if (node.type === "text") return paint(node.value, styles, false);
    if (node.type !== "element") return "";
    const classes = node.properties.className;
    const selected = Array.isArray(classes) ? classes.flatMap(name => typeof name === "string" && syntaxStyles[name] !== undefined ? [syntaxStyles[name]!] : []) : [];
    return syntax(node.children, depth + 1, [...styles, ...selected]);
  }).join("");
  const tokens = (items: Token[], depth = 0, styles: number[] = []): string => items.map(token => {
    enter(depth);
    const children = (value: { tokens?: Token[]; text?: string }, extra: number[] = []) => value.tokens
      ? tokens(value.tokens, depth + 1, [...styles, ...extra]) : paint(value.text ?? "", [...styles, ...extra]);
    switch (token.type) {
      case "space": return "";
      case "checkbox": return ""; // The owning list item supplies its task marker.
      case "paragraph": return children(token as Tokens.Paragraph) + checked("\n\n");
      case "text": return children(token as Tokens.Text);
      case "escape": return paint((token as Tokens.Escape).text, styles);
      case "html": return paint((token as Tokens.HTML).text, styles, false);
      case "strong": return children(token as Tokens.Strong, [1]);
      case "em": return children(token as Tokens.Em, [3]);
      case "del": return children(token as Tokens.Del, [9]);
      case "codespan": return paint((token as Tokens.Codespan).text, [...styles, 36], false);
      case "br": return checked("\n");
      case "hr": return paint("────────", [90]) + checked("\n\n");
      case "heading": return paint("#".repeat((token as Tokens.Heading).depth) + " ", [1, 36]) + children(token as Tokens.Heading, [1, 36]) + checked("\n\n");
      case "link": {
        const link = token as Tokens.Link;
        // Compact only a mechanically matching local citation. Never hide an
        // arbitrary label/target mismatch, remote URL, or different line number.
        const citation = /^([A-Za-z0-9_./-]+)#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(link.href);
        if (citation && !citation[1]!.startsWith("//")) {
          const path = citation[1]!;
          const range = citation[2]! + (citation[3] ? `–${citation[3]}` : "");
          const label = link.text.replace(/(?<=\d)-(?=\d)/g, "–");
          if (label === `${path}:${range}` || label === `${path.split("/").at(-1)}:${range}`)
            return paint(`${path}:${range}`, [4]);
        }
        return children(link, [4]) + (link.text === link.href ? "" : paint(` (${link.href})`, [90]));
      }
      case "image": { const image = token as Tokens.Image; return paint(`[image: ${image.text}] (${image.href})`, [90]); }
      case "blockquote": return tokens((token as Tokens.Blockquote).tokens, depth + 1, styles).trimEnd().split("\n").map(line => checked("│ ") + line).join("\n") + checked("\n\n");
      case "list": {
        const list = token as Tokens.List;
        return list.items.map((item, index) => {
          enter(depth + 1);
          const label = item.task ? (item.checked ? "[x] " : "[ ] ") : list.ordered ? `${Number(list.start) + index}. ` : "• ";
          // Tight items begin with block text, not a paragraph with a trailing newline.
          const blocks = item.tokens.map(block => tokens([block], depth + 2, styles).trimEnd()).filter(Boolean);
          return blocks.join("\n").split("\n").map((line, i) => checked(i ? "  " : label) + line).join("\n");
        }).join("\n") + checked("\n\n");
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = (code.lang ?? "").split(/\s/)[0]!.toLowerCase();
        const body = Buffer.byteLength(code.text) <= MARKDOWN_LIMITS.code && highlighter.registered(language)
          ? syntax(highlighter.highlight(language, terminalText(code.text)).children, depth + 1) : paint(code.text, [], false);
        return paint(`┌─ ${language || "code"}`, [90]) + checked("\n") + body + checked("\n") + paint("└─", [90]) + checked("\n\n");
      }
      case "table": {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[]) => cells.slice(0, 16).map(cell => children(cell));
        const lines = markdownTable(row(table.header), table.rows.slice(0, 100).map(row), columns,
          table.header.length > 16 || table.rows.length > 100);
        return checked(lines + "\n\n");
      }
      case "def": return "";
      default: return paint(token.raw, styles, false);
    }
  }).join("");
  try {
    const normalized = terminalText(source);
    if (Buffer.byteLength(normalized) > MARKDOWN_LIMITS.source) return fallback(source, "normalized source exceeds 32 KiB");
    const result = tokens(lexer.lexer(normalized)).trimEnd();
    if (Buffer.byteLength(result) > MARKDOWN_LIMITS.output) throw Error("output bound");
    return result;
  } catch { return fallback(source, "bounded parser or renderer fallback"); }
}

/** Weak keys do not retain evicted controller lines; Static never retroactively reflows them. */
export function createMarkdownCache(render = renderMarkdown): (line: { text: string; tone: string }, columns: number, color: boolean, assistantTone?: "white" | "black") => string {
  const cache = new WeakMap<object, string>();
  return (line, columns, color, assistantTone) => {
    if (line.tone !== "assistant") return line.text;
    const prior = cache.get(line); if (prior !== undefined) return prior;
    const result = render(line.text, columns, color, assistantTone); cache.set(line, result); return result;
  };
}
