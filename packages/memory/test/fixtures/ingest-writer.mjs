// Run pnpm build before this integration fixture: it imports the real production artifact.
import { FileMemoryStore, addPin, ingestSession } from "../../dist/index.js";
import { readFile } from "node:fs/promises";
const [root, logPath, name] = process.argv.slice(2);
process.send({ ready: true });
process.once("message", async () => {
  try {
    const store = new FileMemoryStore({ root });
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
      if (updating && path === "concepts/shared.md") {
        const owner = await readFile(`${root}.write.lock`, "utf8");
        if (!owner.startsWith(`${process.pid}:`)) throw new Error("page transform read without owning the mutation lock");
      }
      return read(path);
    };
    for (let i = 0; i < 4; i++) {
      const text = `fact ${name} ${i}`;
      const provider = { id: "fixture", model: "fixture",
        capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
        async *stream() {
          yield { type: "text_delta", text: JSON.stringify({ summary: text,
            facts: [{ pageType: "concept", slug: "shared", tag: "observed", text }] }) };
          yield { type: "stop", reason: "end_turn" };
        } };
      await ingestSession({ store, provider, sessionId: `${name}-${i}`, logPath });
      await addPin(root, { page: "concepts/shared.md", kind: "addition", claim: text, anchor: "",
        provenance: "human", created: "2026-09-05", status: "active" });
    }
    process.send({ done: true });
  } catch (error) { process.send({ error: String(error) }); }
  finally { process.disconnect(); }
});
