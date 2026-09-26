#!/usr/bin/env node
// Explicit operator action. Refer to a built, user-owned source installation;
// never copy into the target checkout or silently grant project trust.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "../../packages/core/dist/index.js";
import { projectConfigPath, parseConfigText, readConfigFile } from "./public-api.mjs";
const pack = fileURLToPath(new URL("./", import.meta.url));

export async function activateShip({ project, declaration, home = homedir() }) {
  project = await realpath(project);
  const target = await projectConfigPath(project, home);
  // One complete, strictly parsed per-repository declaration; no guessed checks/pins.
  const text = await readFile(declaration, "utf8");
  if (Buffer.byteLength(text) > 1_048_576) throw new Error("activation declaration exceeds 1 MiB");
  const config = parseConfigText(declaration, text);
  if (!config.checks) throw new Error("activation requires declared packs.ship.checks (steps: [] is explicit none)");
  if (await readConfigFile(join(project, ".agentrig", "config.json"))) throw new Error("project already declares config; configure pack roots there explicitly instead");
  if (await readConfigFile(target)) throw new Error("activation already exists; inspect and edit the per-repository config explicitly");
  const directory = dirname(target), skillsRoot = join(directory, "ship-skills");
  const skills = await discoverSkills({ roots: [join(pack, "skills")], onError: error => { throw error; } });
  if (skills.length !== 6) throw new Error("incomplete ship skill installation");
  const paths = [
    ...["post-review-comment", "review-finding-index", "review-provenance", "review-verdict", "reviewer-adapters", "child-result"].flatMap(name => ["scripts", "packs/ship/scripts"].map(prefix => [`${prefix}/${name}.mjs`, join(pack, "scripts", `${name}.mjs`)])),
    ["packages/cli/dist/project-checks.js", join(pack, "public-api.mjs")],
    ["docs/SHIPPING-WORKFLOW.md", join(pack, "docs/SHIPPING-WORKFLOW.md")],
    ["docs/MERGE-GUARD.md", join(pack, "docs/MERGE-GUARD.md")],
    [".agentrig/config.json", target],
  ];
  // Keep effective policy byte-for-byte; provide explicit resource addresses rather
  // than rewriting examples, command syntax, quotes, or gate predicates.
  const address = `\n\n## Activated ship resource addresses\n\nThis is a foreign-project activation. Workflow resources below belong to the trusted user-owned source installation, not the target repository. Whenever this skill refers to the left-hand resource, use the exact absolute right-hand path (quote shell operands). Read the effective project declaration from the config address, not global home preferences. Target-repository artifacts, heads and evidence remain target-owned. All trust, permission, dispatch, review, authorization and CI gates remain unchanged.\n${paths.map(([from,to]) => `- ${JSON.stringify(from)} → ${JSON.stringify(to)}`).join("\n")}\n`;
  const output = { ...config, skills:[skillsRoot, ...(config.skills ?? [])],
    extension:[join(pack,"extensions/dispatch-record.mjs"), ...(config.extension ?? [])],
    agentRoleRoots:[join(pack,"agents"), ...(config.agentRoleRoots ?? [])], subagents:true };
  // Avoid writing normalized compatibility aliases back as deprecated declarations.
  delete output.checks; delete output.reviewers;
  output.packs = {...config.packs, ship: {...config.packs?.ship, checks:config.checks, ...(config.reviewers === undefined ? {} : {reviewers:config.reviewers})}};
  parseConfigText(target, JSON.stringify(output));
  await mkdir(skillsRoot, {recursive:true});
  for (const skill of skills) await writeFile(join(skillsRoot, `${skill.name}.md`), `---\nname: ${skill.name}\ndescription: ${skill.description}\n${skill.flags ? `flags: ${JSON.stringify(skill.flags)}\n` : ""}---\n\n${skill.body}${address}`, {flag:"wx"});
  await writeFile(target, JSON.stringify(output,null,2)+"\n",{flag:"wx",mode:0o600});
  return {config:target, skills:skillsRoot, extension:output.extension[0], roles:output.agentRoleRoots[0], ciWorkflows:config.packs?.ship?.ciWorkflows};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("usage: node /installation/packs/ship/activate.mjs PROJECT DECLARATION.json");
  console.log(JSON.stringify(await activateShip({project:process.argv[2],declaration:process.argv[3]}),null,2));
}
