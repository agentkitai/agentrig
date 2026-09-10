import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { createAgent, SessionStore, type ModelProvider } from "@agentkitai/agentrig-core";
const observed = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../src/tui/markdown.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/tui/markdown.js")>();
  return { ...real, createMarkdownCache: (renderer = real.renderMarkdown) => real.createMarkdownCache((...args) => { observed.renders++; return renderer(...args); }) };
});
import { renderMarkdown, createMarkdownCache, MARKDOWN_LIMITS, terminalText } from "../src/tui/markdown.js";
import { markdownTable, measureRows, fitToRows, liveRows } from "../src/tui/viewport.js";
import { App } from "../src/tui/app.js";
import { TuiController } from "../src/tui/controller.js";

const source = "# Result\n\n- **Ready**\n- *Next*\n\n| Item | Detail |\n| --- | --- |\n| code | A long explanation that makes column widths observable at both terminal sizes. |\n\n```js\nconst answer = 42;\n```";
const plain = (text: string) => text.replace(/\u001b\[[\d;]*m/g, "");
const roots: string[] = [];
it.each(["white", "black"] as const)("retains heading depth and restores the %s assistant tone after inline SGR", tone => {
  const out = renderMarkdown("# Main\n\n### Detail\n\n**bold** plain `code` end", 80, true, tone);
  expect(plain(out)).toContain("# Main\n\n### Detail");
  expect(out).toContain(`\u001b[0m\u001b[${tone === "white" ? 37 : 30}m plain`);
  expect(out).toContain(`\u001b[0m\u001b[${tone === "white" ? 37 : 30}m end`);
  expect(renderMarkdown("## Plain", 80, false, tone)).toBe("## Plain");
});
afterEach(async () => { vi.unstubAllEnvs(); observed.renders = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("table layout sizes for the longest observed cell, not the shortest header", () => {
  expect(markdownTable(["A", "B"], [["x", "long sentence"]], 80)).toContain("long sentence");
  const a = renderMarkdown(source, 80, true), b = renderMarkdown(source, 120, true);
  expect(a).not.toBe(b);
});

it.each([80, 120])("golden ANSI final reply at %s columns", width => {
  const detail = "A long explanation that makes column widths observable at both terminal sizes.";
  const table = width === 80 ? `Item: code\nDetail: ${detail}`
    : "Item │ Detail" + " ".repeat(detail.length - 6) + "\n"
      + "─────┼" + "─".repeat(detail.length + 1) + "\ncode │ " + detail;
  const expected = "\u001b[1;36m# \u001b[0m\u001b[1;36mResult\u001b[0m\n\n• \u001b[1mReady\u001b[0m\n• \u001b[3mNext\u001b[0m\n\n"
    + table + "\n\n\u001b[90m┌─ js\u001b[0m\n"
    + "\u001b[35mconst\u001b[0m answer = \u001b[33m42\u001b[0m;\n\u001b[90m└─\u001b[0m";
  expect(renderMarkdown(source, width, true)).toBe(expected);
});

it("caches only completed assistant lines at their first width and color", () => {
  const renderer = vi.fn(renderMarkdown), cache = createMarkdownCache(renderer);
  const line = { tone: "assistant", text: source };
  const first = cache(line, 80, true);
  expect(cache(line, 120, false)).toBe(first);
  const notice = { tone: "system", text: "**literal**" };
  expect(cache(notice, 80, true)).toBe(notice.text);
  expect(renderer).toHaveBeenCalledTimes(1);
  expect(cache({ ...line }, 120, false)).not.toBe(first);
  expect(renderer).toHaveBeenCalledTimes(2);
});

it("preserves Unicode, nested emphasis and blockquote/list structure", () => {
  const out = renderMarkdown("> **bold *inside***\n\n1. first\n2. second\n\n你好 👋 café\n\n- [x] done", 80, true);
  expect(out).toContain("\u001b[1;3minside\u001b[0m");
  expect(plain(out)).toContain("│ bold inside");
  expect(plain(out)).toContain("1. first\n2. second");
  expect(plain(out)).toContain("你好 👋 café");
  expect(plain(out).split("\n").at(-1)).toBe("[x] done");
  expect(renderMarkdown("- [ ] pending\n- [x] done", 80, false)).toBe("[ ] pending\n[x] done");
  const table = markdownTable(["字", "value"], [["你好你好你好", "ok"]], 20);
  for (const line of table.split("\n").filter(line => !line.startsWith("["))) expect(measureRows(line, 20)).toBe(1);
});

it.each([
  ["list", "- item\n  - nested\n    - deep\n- second", "• item\n  • nested\n    • deep\n• second"],
  ["fence", "- item\n  ```text\n  body\n  ```", "• item\n  ┌─ text\n  body\n  └─"],
  ["quote", "- item\n  > quote", "• item\n  │ quote"],
])("nested list blocks stay on separate indented lines: %s", (_kind, input, expected) => {
  expect(renderMarkdown(input!, 80, false)).toBe(expected);
});

it("unknown fences remain literal and common fences highlight without changing code text", () => {
  const code = "  const x = '<b>&amp;</b>';";
  const result = renderMarkdown(`\`\`\`not-a-language\n${code}\n\`\`\``, 80, true);
  expect(plain(result)).toContain(code);
  for (const [language, text] of [["js", "const answer = 42;"], ["python", "return 42"], ["json", '{"value": 42}'], ["go", "return 42"], ["rust", "let answer = 42;"]]) {
    const out = renderMarkdown(`\`\`\`${language}\n${text}\n\`\`\``, 80, true);
    expect(plain(out)).toContain(text); expect(out).toContain("\u001b[33m42");
  }
});

it("no source terminal controls survive parsing or entity decoding; HTML and URLs are literal", () => {
  const out = renderMarkdown("# Safe\u001b[2J\u0007\n\n&#27;[31m &#x9b;2J &amp; &lt;x&gt;\n\n<img src=x onerror=boom>\n\n[link](javascript:boom) ![pic](https://fixture.invalid/image)\n\n\u202etext", 80, true);
  expect(plain(out)).toContain("<img src=x onerror=boom>");
  expect(plain(out)).toContain("javascript:boom"); expect(plain(out)).toContain("https://fixture.invalid/image");
  expect(out).not.toContain("\u001b[2J"); expect(out).not.toContain("\u001b[31m");
  expect(plain(out)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  expect(plain(out)).toContain("& <x>");
  expect(terminalText("a\tb\r\nc\r")).toBe("a    b\nc");
});

it("NO_COLOR and explicit plain mode emit no SGR while keeping Markdown structure", () => {
  vi.stubEnv("NO_COLOR", "1");
  const out = renderMarkdown(source, 80);
  expect(out).not.toContain("\u001b"); expect(out).toContain("• Ready"); expect(out).toContain("┌─ js");
  expect(out).toBe(renderMarkdown(source, 80, false));
});

it("source, normalized source, syntax tree and output limits fall back with visible notices", () => {
  for (const text of ["x".repeat(32_769), "\t".repeat(10_000), "> ".repeat(20) + "deep", "*x* ".repeat(2000),
    "[x][ref] ".repeat(1000) + "\n\n[ref]: https://fixture.invalid/" + "a".repeat(200)]) {
    const out = renderMarkdown(text, 80, true);
    expect(out).toContain("Markdown formatting omitted"); expect(out).toContain("original text retained");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MARKDOWN_LIMITS.output);
    expect(plain(out)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  }
});

it("oversized tables explicitly elide rows and columns; narrow layout remains readable", () => {
  const header = Array.from({ length: 17 }, (_, i) => `h${i}`);
  const text = `| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n`
    + Array.from({ length: 101 }, () => `| ${header.map(() => "x").join(" | ")} |`).join("\n");
  expect(renderMarkdown(text, 80, false)).toContain("omitted");
  expect(markdownTable(["A", "B"], [["one", "two"]], 5)).toContain("A: one");
});

class Stdin extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding() { return this; } setRawMode() { return this; } ref() { return this; } unref() { return this; }
  read() { return this.chunks.shift() ?? null; }
  type(text: string) { this.chunks.push(text); this.emit("readable"); }
}

it.each([80, 120])("actual App at %s columns streams raw then formats once, without log changes or input reparsing", async columns => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-markdown-")); roots.push(cwd);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() { yield { type: "text_delta", text: source }; await held; yield { type: "stop", reason: "end_turn" }; } };
  const store = new SessionStore({ root: join(cwd, "logs") });
  const controller = new TuiController({ cwd, agent: createAgent({ provider, store, tools: [], systemPrompt: "fixture", repoMap: false }) });
  const writes: string[] = [], stdin = new Stdin();
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 30, isTTY: true, write(text: string) { writes.push(text); return true; } });
  let mounted!: () => void; const ready = new Promise<void>(resolve => { mounted = resolve; });
  const instance = render(createElement(App, { controller, onMounted: mounted }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
  await ready; const running = controller.prompt("render the fixture");
  try {
    await vi.waitFor(() => expect(controller.snapshot().streaming).toBe(source));
    await vi.waitFor(() => expect(writes.join("")).toContain("```js"));
    expect(observed.renders).toBe(0);
    expect(measureRows(fitToRows(source, columns, liveRows(30)), columns)).toBeLessThanOrEqual(liveRows(30));
    release(); await running;
    await vi.waitFor(() => expect(writes.join("")).toContain("┌─ js"));
    expect(observed.renders).toBe(1);
    expect(controller.snapshot().lines.find(line => line.tone === "assistant")?.text).toBe(source);
    const before = writes.join(""); stdin.type("typed while idle");
    await vi.waitFor(() => expect(writes.join("").length).toBeGreaterThan(before.length));
    expect(observed.renders).toBe(1);
    expect(writes.join("").match(/┌─ js/g)).toHaveLength(1);
    expect(writes.join("")).not.toContain("\u001b[2J");
    const events = await store.readAll(controller.snapshot().sessionId!);
    expect(events.filter(event => event.type === "model.delta").map(event => event.text).join("")).toBe(source);
  } finally { release(); await running.catch(() => {}); await controller.shutdown(); instance.unmount(); }
});
