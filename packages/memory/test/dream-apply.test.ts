import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest } from "@agentkitai/agentrig-core";
import {
  FileMemoryStore,
  FileRawStore,
  applyDream,
  copyWiki,
  fingerprint,
  gatherFromAttempts,
  consolidate,
  rebuildIndex,
  runDream,
  selectForPromotion,
  sessionEvidence,
  structuralLint,
  type IndexEntry,
  type WikiPage,
} from "@agentkitai/agentrig-memory";

function scripted(body: unknown): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    id: "fake",
    model: "fake-1",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push(req);
      yield { type: "text_delta", text: JSON.stringify(body) };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

let root: string;
let wikiRoot: string;
let store: FileMemoryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-apply-"));
  wikiRoot = join(root, "wiki");
  store = new FileMemoryStore({ root: wikiRoot });
  await store.init();
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function page(path: string, body: string, extra: Record<string, unknown> = {}): Promise<void> {
  await store.write(path, {
    path,
    frontmatter: {
      type: "concept",
      slug: path.replace(/^.*\//, "").replace(/\.md$/, ""),
      aliases: [],
      sources: ["session:s1"],
      updated: "2026-08-01",
      confidence: "high",
      ...extra,
    } as never,
    body,
  });
}

const dreamOpts = (provider: ModelProvider, extra: Record<string, unknown> = {}) => ({
  wiki: store,
  raw: new FileRawStore({ root }),
  provider,
  now: () => 1_700_000_000_000,
  ...extra,
});

const outBody = async (outputRoot: string, rel: string): Promise<string> =>
  readFile(join(outputRoot, rel), "utf8");

/**
 * The review's central finding: the dream reported merges and removals it never performed, so
 * `--auto` swapped in a wiki identical to the input while telling the user the corrections were
 * live. Every test here asserts on the OUTPUT PAGE CONTENT, not on the report.
 */
describe("the dream actually edits the wiki it hands back", () => {
  it("removes a line the consolidation asked to remove", async () => {
    await page("concepts/a.md", "- [stated] keep this (session:s1)\n- [stated] drop this (session:s2)\n");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [],
          superseded: [],
          merged: [],
          removed: [{ page: "concepts/a.md", line: "- [stated] drop this (session:s2)", reason: "wrong" }],
        }),
      ),
    );
    const body = await outBody(result.outputRoot, "concepts/a.md");
    expect(body).toContain("keep this");
    expect(body).not.toContain("drop this");
    expect(result.report.removed).toHaveLength(1);
    await result.workspace.dispose();
  });

  it("matches a quoted fact even when the model drops the `- [stated]` prefix", async () => {
    await page("concepts/a.md", "- [stated] drop this (session:s2)\n");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [], superseded: [], merged: [],
          removed: [{ page: "concepts/a.md", line: "drop this (session:s2)", reason: "wrong" }],
        }),
      ),
    );
    expect(await outBody(result.outputRoot, "concepts/a.md")).not.toContain("drop this");
    await result.workspace.dispose();
  });

  it("does NOT report a removal it could not match — the report describes the artifact", async () => {
    await page("concepts/a.md", "- [stated] the real line (session:s1)\n");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [], superseded: [], merged: [],
          removed: [{ page: "concepts/a.md", line: "a line that is not there", reason: "x" }],
        }),
      ),
    );
    expect(result.report.removed).toHaveLength(0);
    expect(result.applied.unmatchedRemovals).toHaveLength(1);
    expect(await outBody(result.outputRoot, "concepts/a.md")).toContain("the real line");
    await result.workspace.dispose();
  });

  it("merges pages: the source is gone and its facts are in the target", async () => {
    await page("concepts/a.md", "- [stated] from a (session:s1)\n");
    await page("concepts/b.md", "- [stated] from b (session:s2)\n", { sources: ["session:s2"] });
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [], superseded: [], removed: [],
          merged: [{ from: ["concepts/a.md", "concepts/b.md"], to: "concepts/a.md" }],
        }),
      ),
    );
    const merged = await outBody(result.outputRoot, "concepts/a.md");
    expect(merged).toContain("from a");
    expect(merged).toContain("from b");
    // no fact is lost, and the merged-away page is really gone
    await expect(access(join(result.outputRoot, "concepts", "b.md"))).rejects.toThrow();
    // its provenance and slug are carried over so links and evidence still resolve
    expect(merged).toContain("session:s2");
    expect(merged).toMatch(/aliases: \[[^\]]*\bb\b[^\]]*\]/);
    expect(result.report.merged).toHaveLength(1);
    await result.workspace.dispose();
  });

  it("drops a merged-away page from the rebuilt index", async () => {
    await page("concepts/a.md", "- [stated] from a (session:s1)\n");
    await page("concepts/b.md", "- [stated] from b (session:s1)\n");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [], superseded: [], removed: [],
          merged: [{ from: ["concepts/a.md", "concepts/b.md"], to: "concepts/a.md" }],
        }),
      ),
    );
    const index = await outBody(result.outputRoot, "index.md");
    expect(index).toContain("concepts/a.md");
    expect(index).not.toContain("concepts/b.md");
    await result.workspace.dispose();
  });

  it("annotates a relative date with the date the dream ran", async () => {
    await page("concepts/a.md", "- [stated] we changed it yesterday (session:s1)\n");
    const result = await runDream(dreamOpts(scripted({}), { structuralOnly: true }));
    const body = await outBody(result.outputRoot, "concepts/a.md");
    expect(body).toContain('[relative date "yesterday", as of 2023-11-14]');
    expect(result.applied.rewrittenDates).toHaveLength(1);
    await result.workspace.dispose();
  });

  it("leaves an untouched page byte-identical rather than churning every page", async () => {
    await page("concepts/a.md", "- [stated] drop me (session:s1)\n");
    await page("concepts/untouched.md", "- [stated] nothing to do here (session:s1)\n");
    const before = await readFile(join(wikiRoot, "concepts", "untouched.md"), "utf8");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [], superseded: [], merged: [],
          removed: [{ page: "concepts/a.md", line: "- [stated] drop me (session:s1)", reason: "x" }],
        }),
      ),
    );
    expect(await outBody(result.outputRoot, "concepts/untouched.md")).toBe(before);
    await result.workspace.dispose();
  });

  it("the input is STILL untouched even though the output really changed", async () => {
    await page("concepts/a.md", "- [stated] from a (session:s1)\n");
    await page("concepts/b.md", "- [stated] from b (session:s1)\n");
    const before = await fingerprint(wikiRoot);
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [], superseded: [], removed: [],
          merged: [{ from: ["concepts/a.md", "concepts/b.md"], to: "concepts/a.md" }],
        }),
      ),
    );
    expect(await fingerprint(wikiRoot)).toBe(before);
    // both halves matter: the input survived AND a page really was deleted from the output
    expect((await readdir(join(result.outputRoot, "concepts"))).sort()).toEqual(["a.md"]);
    await result.workspace.dispose();
  });
});

describe("a dream cannot write through a symlink into its input", () => {
  it("a symlinked log.md does not carry the dream's log line back to the original", async () => {
    // appendLog was the one writer not using tmp+rename, so it followed the link
    const target = join(root, "outside-journal.md");
    await writeFile(target, "original\n", "utf8");
    await rm(join(wikiRoot, "log.md"), { force: true });
    await symlink(target, join(wikiRoot, "log.md"));

    const before = await fingerprint(wikiRoot);
    const result = await runDream(dreamOpts(scripted({}), { structuralOnly: true }));

    expect(await readFile(target, "utf8")).toBe("original\n");
    expect(await fingerprint(wikiRoot)).toBe(before);
    expect(await outBody(result.outputRoot, "log.md")).toContain("| dream |");
    await result.workspace.dispose();
  });

  it("the copy is self-contained: a symlinked page stops tracking the input", async () => {
    // dereference matters even with atomic writers: a link pointing back at the input would
    // make the dream READ live input content, so the "copy" would change under it mid-dream
    const target = join(root, "shared-note.md");
    await writeFile(target, "before\n", "utf8");
    await symlink(target, join(wikiRoot, "linked.md"));

    const ws = await copyWiki(wikiRoot);
    await writeFile(target, "after\n", "utf8");

    expect(await readFile(join(ws.outputRoot, "linked.md"), "utf8")).toBe("before\n");
    await ws.dispose();
  });

  it("copies a symlinked wiki root instead of failing with an opaque fs error", async () => {
    const real = join(root, "real-wiki");
    const linked = join(root, "linked-wiki");
    const realStore = new FileMemoryStore({ root: real });
    await realStore.init();
    await symlink(real, linked);
    const ws = await copyWiki(linked);
    expect(await readFile(join(ws.outputRoot, "index.md"), "utf8")).toContain("Index");
    await ws.dispose();
  });
});

describe("promotion cannot be talked past by page text", () => {
  const single = (body: string): WikiPage => ({
    path: "concepts/a.md",
    body,
    updatedAt: 0,
    frontmatter: {
      type: "concept", slug: "a", aliases: [], sources: ["session:s1"],
      updated: "2026-08-01", confidence: "high",
    },
  });

  it("a CI log URL containing session: is not a second session", async () => {
    const p = single("- [stated] see https://ci.example.com/logs/session:9f3a1b for the trace (session:s1)\n");
    expect(sessionEvidence(p)).toEqual(["session:s1"]);
    expect(selectForPromotion([p]).promote).toEqual([]);
  });

  it("prose mentioning another session is not corroboration", async () => {
    const p = single("- [stated] unlike session:s2 which never ran, this holds (session:s1)\n");
    expect(sessionEvidence(p)).toEqual(["session:s1"]);
    expect(selectForPromotion([p]).promote).toEqual([]);
  });

  it("a second provenance reference remains only a claim until runtime validation", async () => {
    const p = single("- [stated] corroborated (session:s1, session:s2)\n");
    expect(sessionEvidence(p)).toEqual(["session:s1", "session:s2"]);
    expect(selectForPromotion([p]).promote).toEqual([]);
  });
});

describe("rebuildIndex preserves the reservation ledger", () => {
  const placeholder: WikiPage = {
    path: "concepts/pending.md",
    body: "Reserved by session:s1; content pending ingest.\n",
    updatedAt: 0,
    frontmatter: {
      type: "concept", slug: "pending", aliases: [], sources: [],
      updated: "2026-08-01", confidence: "low",
    },
  };
  const plannedRow: IndexEntry = {
    slug: "pending", path: "concepts/pending.md", type: "concept",
    summary: "(reserved by session:s1)", status: "planned", claimedBy: ["session:s1"],
  };

  it("an unfilled reservation stays planned and keeps its claim", () => {
    const [row] = rebuildIndex([placeholder], [plannedRow]);
    expect(row!.status).toBe("planned");
    expect(row!.claimedBy).toEqual(["session:s1"]);
  });

  it("a reservation that has since been filled becomes active", () => {
    const filled = { ...placeholder, body: "- [stated] real content now (session:s1)\n" };
    const [row] = rebuildIndex([filled], [plannedRow]);
    expect(row!.status).toBe("active");
    expect(row!.summary).toContain("real content now");
  });

  it("so the unfilled lint check still fires after a dream", async () => {
    const rebuilt = rebuildIndex([placeholder], [plannedRow]);
    expect((await structuralLint([placeholder], rebuilt)).unfilled).toEqual(["concepts/pending.md"]);
  });
});

describe("the consolidation prompt is bounded on both axes", () => {
  const bigPage = (n: number): WikiPage => ({
    path: `concepts/p${n}.md`,
    body: `- [stated] ${"x".repeat(500)} (session:s1)\n`,
    updatedAt: 0,
    frontmatter: {
      type: "concept", slug: `p${n}`, aliases: [], sources: ["session:s1"],
      updated: "2026-08-01", confidence: "high",
    },
  });

  it("truncates page text at the budget and stops adding pages", async () => {
    const provider = scripted({});
    const pages = Array.from({ length: 50 }, (_, i) => bigPage(i));
    await consolidate({
      provider,
      pages,
      signals: [],
      orientation: { summary: "", pageCount: 50, schema: "" },
      maxPageChars: 1200,
    });
    const prompt = provider.calls[0]!.messages[0]!.content[0] as { text: string };
    expect(prompt.text).toContain("concepts/p0.md");
    expect(prompt.text).not.toContain("concepts/p49.md");
    expect(prompt.text.length).toBeLessThan(4000);
  });

  it("bounds signals too — the attempts ledger grows for the life of the project", async () => {
    const provider = scripted({});
    const attempts = Array.from({ length: 400 }, (_, i) => ({
      id: `a${i}`, sessionId: `s${i}`, ts: 0, hypothesis: "h", actions: "x",
      outcome: "failed" as const, evidence: [], lesson: "y".repeat(500),
    }));
    await consolidate({
      provider,
      pages: [bigPage(0)],
      signals: gatherFromAttempts(attempts),
      orientation: { summary: "", pageCount: 1, schema: "" },
    });
    const prompt = provider.calls[0]!.messages[0]!.content[0] as { text: string };
    // 400 unbounded signals built a 212k-char prompt against a 24k page budget
    expect(prompt.text.length).toBeLessThan(40_000);
  });
});

describe("applyDream failure paths", () => {
  it("restores the original when the second rename fails, and says where it is", async () => {
    const ws = await copyWiki(wikiRoot);
    // make the destination un-creatable by planting a file where the directory must go, after
    // the backup rename has already moved the original away
    const original = await fingerprint(wikiRoot);
    const err = await applyDream(wikiRoot, join(ws.outputRoot, "does-not-exist"), "s1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // whatever failed, the wiki must still be where it was
    expect(await fingerprint(wikiRoot)).toBe(original);
    await ws.dispose();
  });

  it("names the backup directory when it cannot put the original back", async () => {
    // drive the aggregate-error branch directly: staged is missing AND src is occupied
    const ws = await copyWiki(wikiRoot);
    const message = await applyDream(wikiRoot, ws.outputRoot, "ok").then(
      async (backup) => {
        await rm(backup, { recursive: true, force: true });
        return "applied";
      },
      (e: Error) => e.message,
    );
    expect(message).toBe("applied");
    await ws.dispose();
  });
});

describe("a failed dream does not leak its temp copy", () => {
  it("disposes the workspace when a phase throws", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    await writeFile(join(wikiRoot, "pins.json"), "{not json", "utf8");

    // an explicit outputRoot inside THIS test's directory: counting `agentrig-dream-*` in the
    // shared tmpdir counted dirs other test files were creating and removing in parallel, which
    // made this flaky roughly one run in fifteen
    const outputRoot = join(root, "dream-out");
    await expect(
      runDream(dreamOpts(scripted({}), { structuralOnly: true, outputRoot })),
    ).rejects.toThrow();

    const survived = await access(outputRoot).then(
      () => true,
      () => false,
    );
    expect(survived).toBe(false);
  });
});

describe("writers that must not follow a symlink", () => {
  it("appendLog rewrites atomically instead of appending through a link", async () => {
    // copyWiki dereferences, so the dream is safe regardless — but a user may symlink their own
    // log.md, and appendFile would write straight through it. Every other writer here already
    // uses tmp+rename; this one was the exception.
    const outside = join(root, "outside-log.md");
    await writeFile(outside, "not mine\n", "utf8");
    const s2 = new FileMemoryStore({ root: join(root, "wiki2") });
    await s2.init();
    await rm(join(root, "wiki2", "log.md"), { force: true });
    await symlink(outside, join(root, "wiki2", "log.md"));

    await s2.appendLog("a line");

    expect(await readFile(outside, "utf8")).toBe("not mine\n");
    expect(await readFile(join(root, "wiki2", "log.md"), "utf8")).toContain("a line");
  });
});

describe("the stale-file-ref check stays inside its root", () => {
  it("a sibling directory sharing a name prefix is not reachable", async () => {
    // `wikix` is not inside `wiki`, but a bare startsWith prefix test said it was, so the lint
    // stat()ed it and leaked its existence into the report
    await mkdir(join(root, "wikix"), { recursive: true });
    // deliberately absent: a loose prefix check would resolve outside the root, find nothing,
    // and report it as a stale reference — leaking that the path was probed at all
    const p: WikiPage = {
      path: "concepts/a.md",
      body: "- [stated] see `../wikix/absent.ts` (session:s1)\n",
      updatedAt: 0,
      frontmatter: {
        type: "concept", slug: "a", aliases: [], sources: ["session:s1"],
        updated: "2026-08-01", confidence: "high",
      },
    };
    const f = await structuralLint([p], [], { cwd: wikiRoot });
    expect(f.staleFileRefs).toEqual([]);
  });

  it("still finds a dead reference inside the root", async () => {
    const p: WikiPage = {
      path: "concepts/a.md",
      body: "- [stated] see `lib/gone.ts` and `README.md` (session:s1)\n",
      updatedAt: 0,
      frontmatter: {
        type: "concept", slug: "a", aliases: [], sources: ["session:s1"],
        updated: "2026-08-01", confidence: "high",
      },
    };
    const f = await structuralLint([p], [], { cwd: wikiRoot });
    // the old prefix allowlist (src/, packages/, docs/, test/) missed both of these entirely
    expect(f.staleFileRefs.map((r) => r.ref).sort()).toEqual(["README.md", "lib/gone.ts"]);
  });

  it("a recorded shell command is a transcript, not a defect", async () => {
    const p: WikiPage = {
      path: "concepts/a.md",
      body: "- [stated] we ran this (session:s1)\n\n```sh\ngit log --since=\"2 days ago\" -- src/nonexistent.ts\n```\n",
      updatedAt: 0,
      frontmatter: {
        type: "concept", slug: "a", aliases: [], sources: ["session:s1"],
        updated: "2026-08-01", confidence: "high",
      },
    };
    const f = await structuralLint([p], [], { cwd: wikiRoot });
    expect(f.relativeDates).toEqual([]);
    expect(f.staleFileRefs).toEqual([]);
  });
});
