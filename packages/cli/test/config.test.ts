import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { buildAgent, type AgentBuildOptions } from "../src/agent-builder.ts";
import {
  explicitCliValues,
  readConfigFile,
  resolveConfig,
  type ConfigFile,
} from "../src/config.ts";
import { buildProgram } from "../src/program.ts";
import type { RunOptions } from "../src/run.ts";
import type { TuiOptions } from "../src/tui/start.tsx";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ cwd: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), "agentrig-config-"));
  dirs.push(base);
  const cwd = join(base, "project");
  const home = join(base, "home");
  await Promise.all([mkdir(join(cwd, ".agentrig"), { recursive: true }), mkdir(join(home, ".agentrig"), { recursive: true })]);
  return { cwd, home };
}

async function configAt(root: string, value: unknown): Promise<string> {
  const path = join(root, ".agentrig", "config.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

function file(values: ConfigFile): ConfigFile {
  return values;
}

describe("resolveConfig precedence (pure)", () => {
  it("project config beats user config (mutation: reversing user/project makes this fail)", () => {
    const resolved = resolveConfig({
      defaults: { model: "default" },
      user: file({ model: "user" }),
      project: file({ model: "project" }),
    });
    expect(resolved.model).toBe("project");
  });

  it("an explicitly typed CLI flag beats project config (mutation: reversing project/CLI makes this fail)", () => {
    const resolved = resolveConfig({
      defaults: { model: "default" },
      project: file({ model: "project" }),
      cli: { model: "cli" },
    });
    expect(resolved.model).toBe("cli");
  });

  it("a default-valued untyped CLI option does not beat config (mutation: moving defaults after project makes this fail)", () => {
    const cmd = new Command().option("--model <model>", "model", "default");
    cmd.parseOptions([]);
    const defaults = cmd.opts<{ model: string }>();
    expect(explicitCliValues(cmd, defaults)).toEqual({});
    expect(resolveConfig({ defaults, project: file({ model: "project" }), cli: explicitCliValues(cmd, defaults) }).model).toBe("project");
  });

  it("environment beats project while typed CLI still beats environment", () => {
    expect(resolveConfig({ defaults: {}, project: file({ model: "project" }), env: { model: "env" } }).model).toBe("env");
    expect(resolveConfig({ defaults: {}, project: file({ model: "project" }), env: { model: "env" }, cli: { model: "cli" } }).model).toBe("cli");
  });

  it("profiles overlay each file base while project precedence remains intact", () => {
    const resolved = resolveConfig({
      defaults: {},
      user: file({ model: "user-base", provider: "anthropic", profiles: { fast: { model: "user-fast", allow: ["read"] } } }),
      project: file({ model: "project-base", profiles: { fast: { provider: "openai", allow: ["bash"] } } }),
      profile: "fast",
    });
    expect(resolved).toMatchObject({ model: "project-base", provider: "openai", allow: ["bash"] });
  });

  it("rejects an unknown profile and lists the profiles that exist", () => {
    expect(() => resolveConfig({ defaults: {}, user: file({ profiles: { fast: {} } }), project: file({ profiles: { careful: {} } }), profile: "missing" })).toThrow(
      /unknown config profile "missing"; available profiles: careful, fast/,
    );
  });

  it("replaces allow/deny arrays at each layer rather than appending them", () => {
    const resolved = resolveConfig({ defaults: {}, user: file({ allow: ["read", "grep"] }), project: file({ allow: ["bash"], deny: ["rm"] }) });
    expect(resolved.allow).toEqual(["bash"]);
    expect(resolved.deny).toEqual(["rm"]);
  });
});

describe("config file boundary", () => {
  it("rejects credentials anywhere in a config and directs them to env or login", async () => {
    const { cwd } = await fixture();
    const path = await configAt(cwd, { profiles: { work: { apiKey: "secret" } } });
    await expect(readConfigFile(path)).rejects.toThrow(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*profiles\\.work\\.apiKey.*environment variables.*agentrig login`));
  });

  it("names the file and field for a zod-invalid config without exposing a zod stack", async () => {
    const { cwd } = await fixture();
    const path = await configAt(cwd, { supervise: "yes" });
    await expect(readConfigFile(path)).rejects.toThrow(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} at supervise: Expected boolean`));
  });

  it("names an unparseable file and the JSON boundary", async () => {
    const { cwd } = await fixture();
    const path = join(cwd, ".agentrig", "config.json");
    await writeFile(path, "{ nope", "utf8");
    await expect(readConfigFile(path)).rejects.toThrow(new RegExp(`invalid config .*config\\.json at <json>:`));
  });
});

describe("both agent entry points use config", () => {
  it("passes the same configured value through run and the default TUI into built agents", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { shell: "/bin/sh", model: "configured-model" });
    process.env.ANTHROPIC_API_KEY = "test-key";
    const received: Array<RunOptions | TuiOptions> = [];
    const dependencies = {
      config: { cwd, home, env: {} },
      run: async (_task: string, opts: RunOptions) => void received.push(opts),
      tui: async (opts: TuiOptions) => void received.push(opts),
    };

    await buildProgram(dependencies).parseAsync(["node", "agentrig", "run", "test"]);
    await buildProgram(dependencies).parseAsync(["node", "agentrig"]);

    expect(received).toHaveLength(2);
    for (const options of received) {
      expect(options.model).toBe("configured-model");
      const built = await buildAgent(options as AgentBuildOptions);
      expect(built.tools.find((tool) => tool.name === "bash")?.description).toContain("/bin/sh");
    }
  });

  it("honours --profile and typed CLI flags through Commander", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { model: "base", profiles: { fast: { model: "profile" } } });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_task, opts) => void (received = opts) }).parseAsync([
      "node",
      "agentrig",
      "run",
      "test",
      "--profile",
      "fast",
      "--model",
      "cli",
    ]);
    expect(received?.model).toBe("cli");
  });
});
