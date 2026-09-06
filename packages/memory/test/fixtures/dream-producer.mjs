import { copyWiki, inspectDreamWorkspace, withMemoryLock } from "../../dist/index.js";
const workspace = await copyWiki(process.argv[2], process.argv[3]);
process.on("message", async command => {
  try {
    if (command === "release") { await workspace.release(); process.send({ released: true }); }
    else if (command === "lock") await withMemoryLock(workspace.outputRoot, async () => {
      process.send({ locked: true }); await new Promise(() => {});
    });
    else if (command === "exit") process.disconnect();
  } catch (error) { process.send({ error: String(error) }); }
});
process.send({ ready: true, ...(await inspectDreamWorkspace(workspace.outputRoot)) });
