import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function extensionFixture(root: string, name = "hello", source?: string, manifest: unknown = { name, version: "1", apiVersion: 1, surfaces: ["hooks", "tools", "commands"] }) {
  await mkdir(root, { recursive: true });
  const path = join(root, `${name}.mjs`);
  await writeFile(path, source ?? `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
export function activate(ctx) {
  ctx.registerCommand({name:"hello",summary:"Say hello",run(args,io){io.print("hello " + args)}});
  ctx.registerTool({name:"hello_tool",description:"Greet",permission:"read",inputSchema:z.object({}),execute(){return {output:{},display:"hello tool"}}});
  ctx.hooks.on("pre_tool", hook => hook.tool?.name === "bash" ? {action:"deny",reason:"fixture veto"} : {action:"continue"});
  ctx.log("activated");
}`);
  if (manifest !== null) await writeFile(join(root, `${name}.json`), JSON.stringify(manifest));
  return path;
}
