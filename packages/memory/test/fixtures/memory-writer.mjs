// Separate process fixture: production built store, not an in-process mutex mock.
import { FileMemoryStore } from "../../dist/index.js";
const store = new FileMemoryStore({ root: process.argv[2] });
const page = await store.read("concepts/shared.md");
process.send({ ready: true });
process.once("message", async () => {
  try {
    const result = await store.compareAndSwap(page.path, { ...page, body: process.argv[3] }, page.version);
    await store.upsertIndex({ slug: process.argv[3], path: `concepts/${process.argv[3]}.md`, type: "concept", status: "active", summary: process.argv[3] });
    await store.appendLog(process.argv[3]);
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    process.send({ error: String(error) }, () => { process.exitCode = 1; process.disconnect(); });
  }
});
