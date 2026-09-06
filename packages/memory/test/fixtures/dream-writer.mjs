import { readFile, realpath } from "node:fs/promises";
import { FileMemoryStore } from "../../dist/index.js";

const [root, path] = process.argv.slice(2);
const release = Promise.withResolvers();
process.on("message", message => { if (message === "release") release.resolve(); });
const store = new FileMemoryStore({ root });
const read = store.read.bind(store);
let paused = false;
store.read = async (...args) => {
  if (!paused) {
    paused = true;
    const owner = await readFile(`${await realpath(root)}.write.lock`, "utf8");
    if (!owner.startsWith(`${process.pid}:`)) throw new Error("writer does not own the mutation lock");
    process.send({ type: "locked" });
    await release.promise;
  }
  return read(...args);
};
try {
  await store.update(path, current => ({ ...current, body: current.body + "\n- [observed] concurrent process fact (doc:fixture)\n" }));
  await new Promise((resolve, reject) => process.send({ type: "done" }, error => error ? reject(error) : resolve()));
} catch (error) {
  await new Promise(resolve => process.send({ type: "error", message: String(error) }, resolve));
  process.exitCode = 1;
} finally { process.disconnect(); }
