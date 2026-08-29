import { describe, expect, it } from "vitest";
import { factLines, pagePath, parsePage, serializePage, wikilinks } from "@agentkitai/agentrig-memory";
import type { PageFrontmatter } from "@agentkitai/agentrig-memory";

const fm: PageFrontmatter = {
  type: "entity",
  slug: "auth-module",
  aliases: ["auth", "AuthService"],
  sources: ["session:8f2a", "doc:adr-012"],
  updated: "2026-08-29",
  confidence: "high",
};

describe("page format", () => {
  it("round-trips frontmatter and body", () => {
    const body = "- [stated] Retries apply per request (session:8f2a)";
    const parsed = parsePage(serializePage(fm, body));
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body.trim()).toBe(body);
  });

  it("parses inline lists, quoted scalars, and CRLF", () => {
    const text = '---\r\ntype: concept\r\nslug: x\r\naliases: [a, "b c"]\r\nsources: []\r\nupdated: 2026-01-01\r\nconfidence: low\r\n---\r\n\r\nbody\r\n';
    const p = parsePage(text);
    expect(p.frontmatter.aliases).toEqual(["a", "b c"]);
    expect(p.frontmatter.sources).toEqual([]);
    expect(p.body.trim()).toBe("body");
  });

  it("throws on a malformed page rather than half-reading it", () => {
    expect(() => parsePage("no frontmatter here", "p.md")).toThrow(/missing frontmatter/);
    expect(() => parsePage("---\ntype: entity\n", "p.md")).toThrow(/unterminated/);
    expect(() => parsePage("---\ntype: nope\nslug: s\nupdated: x\n---\n", "p.md")).toThrow(/invalid frontmatter/);
  });

  it("extracts tagged fact lines with their source refs", () => {
    const body = [
      "- [stated] A thing (session:8f2a)",
      "- [inferred] Another (dream:2026-08-28, from session:9c11)",
      "not a fact line",
      "- [observed] No ref here",
    ].join("\n");
    const facts = factLines(body);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toMatchObject({ tag: "stated", refs: ["session:8f2a"] });
    expect(facts[1]!.refs).toEqual(["dream:2026-08-28", "from session:9c11"]);
    expect(facts[2]!.refs).toEqual([]);
  });

  it("extracts deduped wikilinks and maps types to directories", () => {
    expect(wikilinks("see [[auth-module]] and [[auth-module]] and [[retry-policy]]")).toEqual([
      "auth-module",
      "retry-policy",
    ]);
    expect(pagePath("concept", "retry-policy")).toBe("concepts/retry-policy.md");
    expect(pagePath("source", "session-1")).toBe("sources/session-1.md");
  });
});
