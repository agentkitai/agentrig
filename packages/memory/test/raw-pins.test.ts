import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileMemoryStore,
  FileRawStore,
  addPin,
  claimSatisfied,
  isSessionLog,
  readPins,
  recheckPins,
} from "@agentkitai/agentrig-memory";
import type { Attempt, Pin } from "@agentkitai/agentrig-memory";

let root: string;
let raw: FileRawStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-raw-"));
  raw = new FileRawStore({ root, now: () => 1000 });
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isSessionLog", () => {
  it("excludes core's resume cache and lock files (they are not raw sources)", () => {
    expect(isSessionLog("abc.jsonl")).toBe(true);
    expect(isSessionLog("abc.snapshot.json")).toBe(false);
    expect(isSessionLog("abc.snapshot.json.tmp")).toBe(false);
    expect(isSessionLog("abc.lock")).toBe(false);
    expect(isSessionLog("notes.md")).toBe(false);
  });
});

describe("FileRawStore", () => {
  it("lists only session logs, newest first, and honors `since`", async () => {
    await writeFile(join(root, "raw/sessions/a.jsonl"), "{}\n");
    await writeFile(join(root, "raw/sessions/a.snapshot.json"), "{}");
    await writeFile(join(root, "raw/sessions/a.lock"), "");
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(root, "raw/sessions/b.jsonl"), "{}\n");

    const all = await raw.sessions();
    expect(all.map((s) => s.id)).toEqual(["b", "a"]);
    const since = await raw.sessions(all[1]!.updatedAt);
    expect(since.map((s) => s.id)).toEqual(["b"]);
  });

  it("copies a doc in without ever overwriting an existing raw source", async () => {
    const src = join(root, "adr.md");
    await writeFile(src, "first");
    const one = await raw.addDoc(src);
    await writeFile(src, "second");
    const two = await raw.addDoc(src);

    expect(one.path).not.toBe(two.path);
    expect(await readFile(one.path, "utf8")).toBe("first");
    expect(await readFile(two.path, "utf8")).toBe("second");
  });

  it("appends attempts immutably and refuses to overwrite one", async () => {
    const attempt: Attempt = {
      id: "a1",
      sessionId: "s1",
      ts: 5,
      hypothesis: "the retry is per batch",
      actions: "read the code",
      outcome: "failed",
      evidence: ["429 on the second call"],
    };
    await raw.addAttempt(attempt);
    await raw.addAttempt({ ...attempt, id: "a2", ts: 1, outcome: "success", lesson: "per request" });
    await expect(raw.addAttempt(attempt)).rejects.toThrow(); // immutable: no silent overwrite

    const all = await raw.attempts();
    expect(all.map((a) => a.id)).toEqual(["a2", "a1"]); // oldest first by ts
    expect(all[0]!.lesson).toBe("per request");
    expect(await raw.attempts("nobody")).toEqual([]);
  });
});

describe("pins", () => {
  const pin: Pin = {
    page: "concepts/retry-policy.md",
    kind: "correction",
    claim: "Retries apply per request, not per batch",
    anchor: "## Semantics",
    provenance: "human",
    created: "2026-08-29",
    status: "active",
  };

  it("claimSatisfied is reword-tolerant but not hallucination-tolerant", () => {
    expect(claimSatisfied(pin.claim, "## Semantics\n- [stated] retries apply per request and not per batch")).toBe(true);
    // one content word dropped in a rewording still counts
    expect(claimSatisfied(pin.claim, "- [stated] retries apply per request")).toBe(true);
    expect(claimSatisfied(pin.claim, "- [stated] something else entirely about auth")).toBe(false);
  });

  it("round-trips pins.json", async () => {
    await addPin(root, pin);
    await addPin(root, pin); // idempotent on the same claim
    expect(await readPins(root)).toHaveLength(1);
  });

  it("re-check: kept, conflict (surfaced not dropped), and orphaned", async () => {
    const store = new FileMemoryStore({ root: join(root, "wiki") });
    await store.init();
    const write = async (body: string) =>
      store.write("concepts/retry-policy.md", {
        path: "concepts/retry-policy.md",
        frontmatter: {
          type: "concept",
          slug: "retry-policy",
          aliases: [],
          sources: [],
          updated: "2026-08-29",
          confidence: "high",
        },
        body,
      });

    await write("## Semantics\n- [stated] Retries apply per request, not per batch");
    expect((await recheckPins(store, [pin]))[0]).toMatchObject({ status: "kept" });

    // regenerated page lost the claim — must surface as a conflict, never be dropped
    await write("## Semantics\n- [stated] Something unrelated about tokens");
    const conflict = (await recheckPins(store, [pin]))[0]!;
    expect(conflict.status).toBe("conflict");
    expect(conflict.pin.claim).toBe(pin.claim);

    // anchor section gone but the claim survives -> orphaned, for a human to re-place
    await write("## Other\n- [stated] Retries apply per request, not per batch");
    expect((await recheckPins(store, [pin]))[0]).toMatchObject({ status: "orphaned" });

    // page gone entirely
    expect((await recheckPins(store, [{ ...pin, page: "concepts/nope.md" }]))[0]).toMatchObject({
      status: "orphaned",
    });
  });
});
