// Run pnpm build before this integration fixture: it imports the real production artifact.
import { FileMemoryStore, addPin, ingestSession } from "../../dist/index.js";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
const [root, logPath, name, mode] = process.argv.slice(2);
process.send({ ready: true });
process.once("message", async () => {
  try {
    const store = new FileMemoryStore({ root });
    const canonicalRoot = await realpath(root);
    let calls = 0; let skipped = 0;
    // Conservation alone can pass by lucky scheduling. Also prove that each process owns
    // the shared mutation lock while reading a page it is about to transform.
    const read = store.read.bind(store);
    const update = store.update.bind(store);
    let updating = false;
    store.update = async (...args) => {
      updating = true;
      try { return await update(...args); } finally { updating = false; }
    };
    store.read = async path => {
      if (updating) {
        const owner = await readFile(`${canonicalRoot}.write.lock`, "utf8");
        if (!owner.startsWith(`${process.pid}:`)) throw new Error("page transform read without owning the mutation lock");
      }
      return read(path);
    };
    for (let i = 0; i < (mode === "distinct" ? 4 : 1); i++) {
      const text = `fact ${name} ${i}`;
      const sessionId = mode === "same" ? "s1" : mode === "case" ? (name === "first" ? "s1" : "S1") : `${name}-${i}`;
      const provider = { id: "fixture", model: "fixture",
        capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
        async *stream() {
          calls++;
          const key = createHash("sha256").update(sessionId.toLowerCase()).digest("hex").slice(0, 32);
          const owner = await readFile(`${canonicalRoot}.ingest-${key}.write.lock`, "utf8");
          if (!owner.startsWith(`${process.pid}:`)) throw new Error("provider entered without owning the session ingest lock");
          yield { type: "text_delta", text: JSON.stringify({ summary: text,
            facts: [{ pageType: "concept", slug: "shared", tag: "observed", text }] }) };
          yield { type: "stop", reason: "end_turn" };
        } };
      const result = await ingestSession({ store, provider, sessionId, logPath });
      if (result.skipped) { skipped++; continue; }
      await addPin(root, { page: "concepts/shared.md", kind: "addition", claim: text, anchor: "",
        provenance: "human", created: "2026-09-05", status: "active" });
    }
    process.send({ done: true, calls, skipped });
  } catch (error) { process.send({ error: String(error) }); }
  finally { process.disconnect(); }
});
