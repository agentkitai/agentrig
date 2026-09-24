import { expect, it, vi } from "vitest";
// @ts-expect-error standalone helper
import { START, END, hasVerdictBlock, parseVerdict, verdictBlock } from "../../../scripts/review-verdict.mjs";
// @ts-expect-error standalone helper
import { findingIndex } from "../../../scripts/review-finding-index.mjs";
const valid = { version: 1, reviewedHead: "a".repeat(40), assertedModel: "fixture", modelSource: "fixture", slot: "Codex", verdict: "PASS", findings: [] };
const url = "https://github.com/agentkitai/agentrig/pull/489#issuecomment-1";
const examples = [
  `${START} followed by ${END}`,
  `${START} is the opening delimiter; ${END} is the closing delimiter.`,
  `Discuss \`${START}\` and \`${END}\` inline.`,
  `> ${START}\n> ${END}`,
  `\`${START}\`\n\`${END}\``,
  `\`\`\`md\n${START}\n{}\n${END}\n\`\`\``,
  `~~~md\n${START}\n{}\n${END}\n~~~`,
  `    ${START}\n    ${END}`,
];
it.each(["\n", "\r\n"])("#490 examples do not delimit machine blocks (%j)", eol => {
  for (const example of examples) {
    const prose = example.replaceAll("\n", eol);
    expect(hasVerdictBlock(prose)).toBe(false);
    for (const body of [prose + eol + verdictBlock(valid), verdictBlock(valid) + eol + prose]) {
      expect(parseVerdict(body.replace(/\r?\n/g, eol), valid)).toEqual(valid);
    }
  }
});
it.each(["\n", "\r\n"])("#490 malformed real delimiters never fall back (%j)", eol => {
  for (const body of [verdictBlock(valid) + "\n" + verdictBlock(valid), START, END, `${END}\n${START}`, `${START}\n{}\n<!-- /agentrig-verdict:v2 -->`, verdictBlock(valid) + "\n<!-- agentrig-verdict:v2 -->", verdictBlock(valid) + "\n<!-- agentrig-verdict:v1", verdictBlock(valid) + "\n<!-- /agentrig-verdict", `${START}\n{}\n${END}`]) {
    const text = body.replaceAll("\n", eol);
    expect(hasVerdictBlock(text)).toBe(true);
    expect(() => parseVerdict(text)).toThrow();
  }
});
it.each(["\n", "\r\n"])("#492 nested lists warn without changing the schema index (%j)", eol => {
  const nested = ["    - HIGH: Unsanitized emit reaches the event log", "\t- HIGH: Tab nested assertion", "    1. LOW: Numbered nested assertion"];
  const excluded = ["```md", ...nested, "```", ...nested.map(s => `> ${s}`), "    HIGH: Indented code", "\tHIGH: Tab code"];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const structured of [false, true]) {
      warn.mockClear();
      const body = ["- Blockers:", ...nested, ...excluded, ...(structured ? [verdictBlock(valid)] : [])].join("\n").replaceAll("\n", eol);
      expect(findingIndex(url, { html_url: url, body })).toEqual([]);
      const logs = warn.mock.calls.flat();
      for (const heading of nested) expect(logs.filter(line => line.includes(heading))).toHaveLength(1);
      expect(logs).toHaveLength(nested.length + (structured ? 0 : 1));
      expect(logs.every(line => line.includes("nonfatal"))).toBe(true);
    }
  } finally { warn.mockRestore(); }
});
it("#490 index scans prose around the real block, not quoted delimiter substrings", () => {
  const heading = "### HIGH: Omitted assertion";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const body = [examples[0], verdictBlock(valid), heading].join("\n");
    expect(findingIndex(url, { html_url: url, body })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(heading);
  } finally { warn.mockRestore(); }
});
