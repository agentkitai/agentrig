import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const cwd = fileURLToPath(new URL("..", import.meta.url));
function host(code: string) {
  const env = { ...process.env }; delete env.AGENTRIG_CHILD_PROFILE;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", code, "--", "--not-agentrig-argv"], { cwd, env, encoding: "utf8", timeout: 15000 });
}
it("published root is import-safe and executes a fixture pack via its public API", () => {
  const result = host(`
    import { buildProgram } from '@agentkitai/agentrig-cli';
    const program = buildProgram({ packs: [{ name: 'fixture', summary: 'Fixture', commands: [{
      name: 'echo', summary: 'Echo', run: async (args, { print }) => { print(args.join('|')); }
    }] }] });
    await program.parseAsync(['fixture', 'echo', 'public', '--', '--literal'], { from: 'user' });
  `);
  expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  expect(result.stdout).toBe("public|--literal\n");
});
it("public role, child-environment and project-check helpers work without private imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-public-"));
  try {
    const home = join(root, "home"), project = join(root, "project");
    for (const dir of [home, project]) await mkdir(join(dir, ".agentrig"), { recursive: true });
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { test: { childEnv: { LANG: "fixture" } } } }));
    await writeFile(join(project, ".agentrig/config.json"), JSON.stringify({ checks: { bootstrap: "never executed", steps: [] } }));
    const result = host(`
      import { buildRoleProvider, resolveChildEnvironment, resolveProjectChecks } from '@agentkitai/agentrig-cli';
      const built = buildRoleProvider({ provider: 'anthropic', model: 'unused', providers: { local: { provider: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1' } }, roles: { memory: 'local' } }, 'memory', { env: {}, probe: true });
      const env = await resolveChildEnvironment({ home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(project)}, profile: 'test', env: {}, project: {} });
      const checks = await resolveProjectChecks(${JSON.stringify(project)});
      console.log(JSON.stringify({ provider: built.id, lang: env.LANG, checks }));
    `);
    expect(result.stderr).toContain("Deprecated config key checks; use packs.ship.checks instead."); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ provider: "openai-compatible", lang: "fixture", checks: { bootstrap: "never executed", steps: [] } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("direct and symlinked executable invocation retain help behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-bin-"));
  try {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const link = join(root, "agentrig.mjs"); await symlink(entry, link);
    for (const path of [entry, link]) {
      const result = spawnSync(process.execPath, [path, "--help"], { encoding: "utf8", timeout: 15000 });
      expect(result.status).toBe(0); expect(result.stdout).toContain("Usage: agentrig");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("published host registers its own strict Zod schema and receives parsed namespace config", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-pack-schema-"));
  try {
    const home = join(root, "home"), project = join(root, "project");
    await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(project);
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ packs: { fixture: { greeting: "public" } } }));
    const result = host(`
      import { z } from 'zod';
      import { buildProgram, parseConfigText } from '@agentkitai/agentrig-cli';
      const pack = { name: 'fixture', summary: 'Fixture', configSchema: z.object({ greeting: z.string() }).strict(),
        commands: [{ name: 'echo', summary: 'Echo', run: (_args, { config, print }) => print(config.greeting) }] };
      parseConfigText('fixture', '{"packs":{"fixture":{"greeting":"ok"}}}', { packs: [pack] });
      const program = buildProgram({ packs: [pack], config: { home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(project)}, env: {}, notice: () => {} } });
      await program.parseAsync(['fixture', 'echo'], { from: 'user' });
    `);
    expect(result.status).toBe(0); expect(result.stdout).toBe("public\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
