import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ cwd: string; home: string }> {
  // Canonicalized for the same reason as the agent tests: the trust store is keyed by realpath,
  // and macOS's tmpdir is a symlink — a raw-path trust key is silently "not trusted" there.
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentrig-config-")));
  dirs.push(base);
  const cwd = join(base, "project");
  const home = join(base, "home");
  await Promise.all([mkdir(join(cwd, ".agentrig"), { recursive: true }), mkdir(join(home, ".agentrig"), { recursive: true })]);
  // R1b tests exercise config precedence, not consent; their fixture is already trusted.
  await writeFile(join(home, ".agentrig", "trust.json"), JSON.stringify({ projects: { [cwd]: true } }), "utf8");
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
      defaults: { model: "default" },
      user: file({ model: "user-base", profiles: { fast: { model: "user-profile" } } }),
      project: file({ model: "project-base", profiles: { fast: { model: "project-profile" } } }),
      profile: "fast",
    });
    // One conflicting key pins every edge: default < user base < user profile < project base < project profile.
    expect(resolved.model).toBe("project-profile");
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

  it("allows credential-like profile labels while still checking settings inside them", async () => {
    const { cwd } = await fixture();
    const path = await configAt(cwd, { profiles: { secret: { model: "local" } } });
    await expect(readConfigFile(path)).resolves.toMatchObject({ profiles: { secret: { model: "local" } } });
  });

  it("rejects an out-of-range supervisor soft threshold at the config field", async () => {
    const { cwd } = await fixture();
    const path = await configAt(cwd, { supervisorSoft: 0 });
    await expect(readConfigFile(path)).rejects.toThrow(/config\.json at supervisorSoft: must be greater than 0 and at most 1/);
  });

  it("accepts only positive integer supervisor turn floors", async () => {
    const { cwd } = await fixture();
    const valid = await configAt(cwd, { supervisorTurnsRemaining: 20 });
    await expect(readConfigFile(valid)).resolves.toMatchObject({ supervisorTurnsRemaining: "20" });
    const invalid = await configAt(cwd, { supervisorTurnsRemaining: 2.5 });
    await expect(readConfigFile(invalid)).rejects.toThrow(/supervisorTurnsRemaining: must be a positive integer/);
  });
});

describe("both agent entry points use config", () => {
  it("passes the same configured value through run and the default TUI into built agents", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { shell: "/bin/bash", model: "configured-model", repoMap: false });
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
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
      expect(options.repoMap).toBe(false);
      const built = await buildAgent(options as AgentBuildOptions);
      expect(built.tools.find((tool) => tool.name === "bash")?.description).toContain("/bin/bash");
    }
  });

  it("passes both repo-map flag polarities through config resolution", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { repoMap: false });
    const received: RunOptions[] = [];
    const dependencies = {
      config: { cwd, home, env: {} },
      run: async (_task: string, opts: RunOptions) => void received.push(opts),
    };

    await buildProgram(dependencies).parseAsync(["node", "agentrig", "run", "off", "--no-repo-map"]);
    await buildProgram(dependencies).parseAsync(["node", "agentrig", "run", "on", "--repo-map"]);
    expect(received.map((opts) => opts.repoMap)).toEqual([false, true]);
  });

  it("uses separate turn defaults for interactive and headless entry modes, including resume", async () => {
    const { cwd, home } = await fixture();
    const received: Array<{ entry: string; maxTurns: string }> = [];
    const dependencies = {
      config: { cwd, home, env: {} },
      run: async (_task: string, opts: RunOptions) => void received.push({ entry: opts.resume === undefined ? "run" : "resume", maxTurns: opts.maxTurns }),
      tui: async (opts: TuiOptions) => void received.push({ entry: "tui", maxTurns: opts.maxTurns }),
    };

    await buildProgram(dependencies).parseAsync(["node", "agentrig", "run", "test"]);
    await buildProgram(dependencies).parseAsync(["node", "agentrig"]);
    await buildProgram(dependencies).parseAsync(["node", "agentrig", "sessions", "resume", "s1"]);

    expect(received).toEqual([
      { entry: "run", maxTurns: "300" },
      { entry: "tui", maxTurns: "50" },
      { entry: "resume", maxTurns: "300" },
    ]);
  });

  it("lets project config override both mode defaults", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { maxTurns: 90 });
    const received: string[] = [];
    const dependencies = {
      config: { cwd, home, env: {} },
      run: async (_task: string, opts: RunOptions) => void received.push(opts.maxTurns),
      tui: async (opts: TuiOptions) => void received.push(opts.maxTurns),
    };

    await buildProgram(dependencies).parseAsync(["node", "agentrig", "run", "test"]);
    await buildProgram(dependencies).parseAsync(["node", "agentrig"]);
    expect(received).toEqual(["90", "90"]);
  });

  it("treats a typed old default as explicit and lets it beat the headless default and config", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { maxTurns: 90 });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_task, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test", "--max-turns", "50",
    ]);
    expect(received?.maxTurns).toBe("50");
  });

  it("resolves the turn-warning floor through config and explicit CLI precedence", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { supervisorTurnsRemaining: 20 });
    const received: string[] = [];
    const dependencies = {
      config: { cwd, home, env: {} },
      run: async (_task: string, opts: RunOptions) => void received.push(opts.supervisorTurnsRemaining),
    };
    await buildProgram(dependencies).parseAsync(["node", "agentrig", "run", "test"]);
    await buildProgram(dependencies).parseAsync([
      "node", "agentrig", "run", "test", "--supervisor-turns-remaining", "7",
    ]);
    expect(received).toEqual(["20", "7"]);
  });

  it("appends discovered .agentrig/skills dirs AFTER explicit ones, so explicit shadows (issue #61)", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, {});
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_t, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test", "--skills", "/explicit/one", "--skills", "/explicit/two",
    ]);
    // explicit dirs first (discoverSkills is first-root-wins), then trusted project, then home
    expect(received?.skills).toEqual([
      "/explicit/one",
      "/explicit/two",
      join(cwd, ".agentrig", "skills"),
      join(home, ".agentrig", "skills"),
    ]);
  });

  it("contributes no project skills dir from an untrusted checkout (issue #61)", async () => {
    // Same fixture minus the trust record: headless run, no --trust, so the project is untrusted.
    // Project skills are repo-controlled prompt text and must ride the same R1d boundary.
    const base = await realpath(await mkdtemp(join(tmpdir(), "agentrig-config-")));
    dirs.push(base);
    const cwd = join(base, "project");
    const home = join(base, "home");
    await Promise.all([mkdir(join(cwd, ".agentrig"), { recursive: true }), mkdir(join(home, ".agentrig"), { recursive: true })]);
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_t, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test",
    ]);
    expect(received?.skills).not.toContain(join(cwd, ".agentrig", "skills"));
    // the user-level dir is still safe to load — home is outside the project boundary
    expect(received?.skills).toContain(join(home, ".agentrig", "skills"));
  });

  it("skillDiscovery: false disables the conventional dirs while explicit ones survive (issue #61)", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { skillDiscovery: false });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_t, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test", "--skills", "/explicit/only",
    ]);
    expect(received?.skills).toEqual(["/explicit/only"]);
  });

  it("--no-skill-discovery beats a config that enables it, and --skill-discovery beats one that disables it", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { skillDiscovery: true });
    let received: RunOptions | undefined;
    const deps = { config: { cwd, home, env: {} }, run: async (_t: string, opts: RunOptions) => void (received = opts) };
    await buildProgram(deps).parseAsync(["node", "agentrig", "run", "test", "--no-skill-discovery"]);
    expect(received?.skills).toEqual([]);

    await configAt(cwd, { skillDiscovery: false });
    await buildProgram(deps).parseAsync(["node", "agentrig", "run", "test", "--skill-discovery"]);
    expect(received?.skills).toContain(join(cwd, ".agentrig", "skills"));
  });

  it("honours --profile through Commander without another layer masking it", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { model: "base", profiles: { fast: { model: "profile" } } });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_task, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test", "--profile", "fast",
    ]);
    expect(received?.model).toBe("profile");
  });

  it("honours a --profile placed before the subcommand — the alias shape (issue #56)", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { model: "base", profiles: { fast: { model: "profile" } } });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_task, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "--profile", "fast", "run", "test",
    ]);
    expect(received?.model).toBe("profile");
  });

  it("recovers --profile through sessions resume, the only two-level config entry point", async () => {
    // adversarial-review finding F3: a plausible mutant (cmd.parent?.opts() instead of
    // optsWithGlobals — the parent is `sessions`, not the root) survived the whole suite,
    // because no test covered profile recovery on a NESTED subcommand
    const { cwd, home } = await fixture();
    await configAt(cwd, { model: "base", profiles: { fast: { model: "profile" } } });
    let received: RunOptions | undefined;
    let task: string | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (t, opts) => { task = t; received = opts; } }).parseAsync([
      "node", "agentrig", "sessions", "resume", "s1", "keep", "going", "--profile", "fast",
    ]);
    expect(received?.model).toBe("profile");
    expect(received?.resume).toBe("s1");
    expect(task).toBe("keep going");
  });

  it("honours a leading --profile on the default TUI launch", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { model: "base", profiles: { fast: { model: "profile" } } });
    let received: TuiOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, tui: async (opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "--profile", "fast",
    ]);
    expect(received?.model).toBe("profile");
  });

  it("treats a typed value equal to the built-in default as an explicit CLI override", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { model: "project-model" });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_task, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test", "--model", "claude-sonnet-5",
    ]);
    expect(received?.model).toBe("claude-sonnet-5");
    expect(received?.modelExplicit).toBe(true);
  });

  it("lets an explicit negative boolean override project config", async () => {
    const { cwd, home } = await fixture();
    await configAt(cwd, { supervise: true });
    let received: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {} }, run: async (_task, opts) => void (received = opts) }).parseAsync([
      "node", "agentrig", "run", "test", "--no-supervise",
    ]);
    expect(received?.supervise).toBe(false);
  });
});
