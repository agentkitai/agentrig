import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnose, type DoctorOptions, type DoctorProbes } from "../src/doctor.ts";
import { buildProgram } from "../src/program.ts";

const HOME = "/home/tester";
const ROOT = "/work/project";
const TRUST = join(HOME, ".agentrig", "trust.json");
const USER_CONFIG = join(HOME, ".agentrig", "config.json");
const PROJECT_CONFIG = join(ROOT, ".agentrig", "config.json");
const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

interface Fixture {
  options: DoctorOptions;
  files: Map<string, string>;
  reads: string[];
  accesses: string[];
  probes: DoctorProbes;
}

function fixture(): Fixture {
  const files = new Map<string, string>([
    [TRUST, JSON.stringify({ projects: { [ROOT]: true } })],
  ]);
  const reads: string[] = [];
  const accesses: string[] = [];
  const probes: DoctorProbes = {
    async readFile(path) {
      reads.push(path);
      const value = files.get(path);
      if (value === undefined) throw missing();
      return value;
    },
    async access(path) { accesses.push(path); },
    async stat(path) {
      return {
        isDirectory: () => !path.endsWith("index.md"),
        isFile: () => path.endsWith("index.md"),
      };
    },
    async boundary() { return { projectRoot: ROOT, userStateSafe: true }; },
    async commandExists() { return true; },
    async gitState() { return { inside: true, branch: "feat/test", detached: false }; },
  };
  return {
    files,
    reads,
    accesses,
    probes,
    options: {
      cwd: ROOT,
      home: HOME,
      env: { ANTHROPIC_API_KEY: "fabricated-anthropic-secret" },
      now: () => 1_700_000_000_000,
      stdinTTY: true,
      stdoutTTY: true,
      probes,
    },
  };
}

function find(lines: string[], label: string): string {
  const found = lines.find((candidate) => candidate.startsWith(`pass ${label} `)
    || candidate.startsWith(`fail ${label} `)
    || candidate.startsWith(`skip ${label} `));
  expect(found, `missing doctor line ${label}`).toBeDefined();
  return found!;
}

describe("agentrig doctor", () => {
  it("is registered as a thin command with diagnostic override flags", () => {
    const doctor = buildProgram().commands.find((command) => command.name() === "doctor");
    expect(doctor).toBeDefined();
    expect(doctor!.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      "--provider", "--model", "--profile", "--memory", "--mcp-config",
    ]));
  });

  it("passes provider credentials without printing their value", async () => {
    const f = fixture();
    const result = await diagnose(f.options);
    expect(find(result.lines, "credentials")).toContain("pass credentials");
    expect(result.lines.join("\n")).not.toContain("fabricated-anthropic-secret");
  });

  it("mutation: missing Anthropic credentials names the exact fix", async () => {
    const f = fixture();
    const result = await diagnose({ ...f.options, env: {} });
    expect(find(result.lines, "credentials")).toContain("set ANTHROPIC_API_KEY");
  });

  it("checks OpenAI credentials in both directions", async () => {
    const pass = fixture();
    pass.files.set(USER_CONFIG, JSON.stringify({ provider: "openai", model: "gpt-test" }));
    let result = await diagnose({ ...pass.options, env: { OPENAI_API_KEY: "never-print-me" } });
    expect(find(result.lines, "credentials")).toContain("OPENAI_API_KEY is present");
    expect(result.lines.join("\n")).not.toContain("never-print-me");

    result = await diagnose({ ...pass.options, env: {} });
    expect(find(result.lines, "credentials")).toContain("set OPENAI_API_KEY");
  });

  it("reports ChatGPT token source and expiry while redacting the entire fabricated token", async () => {
    const f = fixture();
    const secret = `header.${Buffer.from(JSON.stringify({ exp: 1_700_000_600 })).toString("base64url")}.FABRICATED_SECRET_SIGNATURE`;
    const authPath = join(HOME, ".agentrig", "openai-chatgpt-auth.json");
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "openai-chatgpt", model: "gpt-test" }));
    f.files.set(authPath, JSON.stringify({ accessToken: secret, refreshToken: "FABRICATED_REFRESH_SECRET" }));
    const result = await diagnose({ ...f.options, env: {} });
    expect(find(result.lines, "credentials")).toMatch(/token bundle readable.*expires in 10m/);
    expect(result.lines.join("\n")).not.toContain(secret);
    expect(result.lines.join("\n")).not.toContain("FABRICATED_SECRET");
  });

  it("passes an expired access token when its refresh bundle is usable", async () => {
    const f = fixture();
    const token = `x.${Buffer.from(JSON.stringify({ exp: 1_699_999_000 })).toString("base64url")}.x`;
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "openai-chatgpt", model: "gpt-test" }));
    f.files.set(join(HOME, ".agentrig", "openai-chatgpt-auth.json"), JSON.stringify({ accessToken: token, refreshToken: "refresh" }));
    const result = await diagnose({ ...f.options, env: {} });
    expect(find(result.lines, "credentials")).toContain("0m remaining and the runtime will refresh");
  });

  it("fails an unusable ChatGPT bundle and names login as the fix", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "openai-chatgpt", model: "gpt-test" }));
    f.files.set(join(HOME, ".agentrig", "openai-chatgpt-auth.json"), JSON.stringify({ accessToken: "secret", refreshToken: "" }));
    const result = await diagnose({ ...f.options, env: {} });
    expect(find(result.lines, "credentials")).toContain("run agentrig login openai-chatgpt");
  });

  it("accepts a Codex-shaped ChatGPT token file without rewriting it", async () => {
    const f = fixture();
    const token = `x.${Buffer.from(JSON.stringify({ exp: 1_700_000_600 })).toString("base64url")}.x`;
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "openai-chatgpt", model: "gpt-test" }));
    f.files.set(join(HOME, ".agentrig", "openai-chatgpt-auth.json"), JSON.stringify({ tokens: { access_token: token, refresh_token: "refresh" } }));
    expect(find((await diagnose({ ...f.options, env: {} })).lines, "credentials")).toContain("expires in 10m");
  });

  it("passes valid user and project config files", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ model: "user-model" }));
    f.files.set(PROJECT_CONFIG, JSON.stringify({ provider: "openai", model: "project-model", baseUrl: "http://localhost:1234" }));
    const result = await diagnose(f.options);
    expect(find(result.lines, "config:user")).toContain("pass");
    expect(find(result.lines, "config:project")).toContain("pass");
  });

  it("fails malformed user config with a named repair and never echoes source context", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, `{ "model": "FABRICATED_CONFIG_SECRET"`);
    const result = await diagnose(f.options);
    expect(find(result.lines, "config:user")).toContain(`fix ${JSON.stringify(USER_CONFIG)}`);
    expect(result.lines.join("\n")).not.toContain("FABRICATED_CONFIG_SECRET");
  });

  it("fails malformed trusted project config with a named repair", async () => {
    const f = fixture();
    f.files.set(PROJECT_CONFIG, "not-json");
    const result = await diagnose(f.options);
    expect(find(result.lines, "config:project")).toContain(`fix ${JSON.stringify(PROJECT_CONFIG)}`);
  });

  it("never opens an untrusted project config and reports the mandated skip", async () => {
    const f = fixture();
    f.files.set(TRUST, JSON.stringify({ projects: { [ROOT]: false } }));
    f.files.set(PROJECT_CONFIG, `{ "apiKey": "MALICIOUS_PROJECT_SECRET" }`);
    const result = await diagnose(f.options);
    expect(find(result.lines, "config:project")).toContain("skipped (untrusted)");
    expect(f.reads).not.toContain(PROJECT_CONFIG);
    expect(result.lines.join("\n")).not.toContain("MALICIOUS_PROJECT_SECRET");
  });

  it("reports the skill directories a run would load, and why (issue #61)", async () => {
    const trusted = fixture();
    let result = await diagnose(trusted.options);
    const skills = find(result.lines, "skills");
    expect(skills).toContain("pass");
    expect(skills).toContain("project");
    expect(skills).toContain("user");

    // discovery disabled by config: the line says so instead of listing conventional dirs
    const disabled = fixture();
    disabled.files.set(USER_CONFIG, JSON.stringify({ skillDiscovery: false }));
    result = await diagnose(disabled.options);
    expect(find(result.lines, "skills")).toContain("discovery disabled");

    // untrusted project: the project dir is named as skipped, never silently included
    const untrusted = fixture();
    untrusted.files.set(TRUST, JSON.stringify({ projects: {} }));
    result = await diagnose(untrusted.options);
    expect(find(result.lines, "skills")).toContain("project skills skipped (untrusted)");

    // invalid config: the line must not assert dirs a run would never reach (review F3) —
    // same contract as the credentials line in that state
    const invalid = fixture();
    invalid.files.set(USER_CONFIG, JSON.stringify({ supervise: "yes" }));
    result = await diagnose(invalid.options);
    expect(find(result.lines, "skills")).toContain("unknown until the failed config");
  });

  it("honours a --profile placed before the doctor subcommand (issue #56)", async () => {
    // the root-level --profile is scanned out of argv before dispatch, so doctor's own opts
    // never see it; the action must recover it via optsWithGlobals or diagnose the wrong profile
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ profiles: { work: { model: "work-model" } } }));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      const program = buildProgram({ doctor: f.options });
      program.exitOverride((err) => { throw err; });
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      await program.parseAsync(["--profile", "work", "doctor"], { from: "user" }).catch(() => {});
      expect(find(lines, "config:profile")).toContain("pass");
    } finally {
      spy.mockRestore();
    }
  });

  it("passes an active profile and fails an absent one with the fix named", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ profiles: { work: { model: "work-model" } } }));
    let result = await diagnose({ ...f.options, cli: { profile: "work" } });
    expect(find(result.lines, "config:profile")).toContain("pass");
    result = await diagnose({ ...f.options, cli: { profile: "missing" } });
    expect(find(result.lines, "config:profile")).toContain('add it under profiles or remove --profile "missing"');
  });

  it("reports effective provider/model and the winning precedence layers", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "openai", model: "user", profiles: { work: { model: "user-profile" } } }));
    f.files.set(PROJECT_CONFIG, JSON.stringify({ provider: "openai-chatgpt", profiles: { work: { model: "project-profile" } } }));
    const result = await diagnose({
      ...f.options,
      env: { AGENTRIG_MODEL: "env-model", AGENTRIG_OPENAI_CHATGPT_TOKEN: JSON.stringify({ accessToken: "opaque", refreshToken: "r", lastRefresh: 1_700_000_000_000 }) },
      cli: { profile: "work", model: "cli-model" },
    });
    expect(find(result.lines, "config:effective")).toContain('provider "openai-chatgpt" from "project config"; model "cli-model" from "CLI flag"');
  });

  it("reports trusted state and fails undecided state with the trust fix named", async () => {
    const trusted = fixture();
    expect(find((await diagnose(trusted.options)).lines, "trust")).toContain("trusted");
    trusted.files.delete(TRUST);
    const result = await diagnose(trusted.options);
    expect(find(result.lines, "trust")).toContain("run agentrig with --trust or answer the trust prompt interactively");
  });

  it("passes a writable memory directory and readable wiki index", async () => {
    const f = fixture();
    const result = await diagnose(f.options);
    expect(find(result.lines, "memory")).toContain("exists and is a writable directory");
    expect(find(result.lines, "memory:index")).toContain("is a readable file");
  });

  it("fails memory directory and index probes with agentrig memory init named", async () => {
    const f = fixture();
    f.probes.access = async () => { throw Object.assign(new Error("denied secret"), { code: "EACCES" }); };
    const result = await diagnose(f.options);
    expect(find(result.lines, "memory")).toContain("run agentrig memory init --dir");
    expect(find(result.lines, "memory:index")).toContain("run agentrig memory init --dir");
    expect(result.lines.join("\n")).not.toContain("denied secret");
  });

  it("passes MCP parsing and an endpoint command found on PATH", async () => {
    const f = fixture();
    const path = join(ROOT, "mcp.json");
    f.files.set(path, JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));
    const result = await diagnose({ ...f.options, cli: { mcpConfig: path } });
    expect(find(result.lines, "mcp")).toContain("parses (1 server)");
    expect(find(result.lines, 'mcp:"docs"')).toContain("exists on PATH");
  });

  it("fails malformed MCP config with its repair flag and redacts env values", async () => {
    const f = fixture();
    const path = join(ROOT, "mcp.json");
    f.files.set(path, `{ "mcpServers": { "x": { "env": { "TOKEN": "MCP_SECRET" } } }`);
    const result = await diagnose({ ...f.options, cli: { mcpConfig: path } });
    expect(find(result.lines, "mcp")).toContain(`fix --mcp-config ${JSON.stringify(path)}`);
    expect(result.lines.join("\n")).not.toContain("MCP_SECRET");
  });

  it("fails a missing MCP server command with install/PATH as the named fix", async () => {
    const f = fixture();
    const path = join(ROOT, "mcp.json");
    f.files.set(path, JSON.stringify({ mcpServers: { docs: { command: "missing-server" } } }));
    f.probes.commandExists = async () => false;
    const result = await diagnose({ ...f.options, cli: { mcpConfig: path } });
    expect(find(result.lines, 'mcp:"docs"')).toContain('install it or put "missing-server" on PATH');
  });

  it("reports Git branch, detached HEAD, and outside-repository states as informational", async () => {
    const f = fixture();
    expect(find((await diagnose(f.options)).lines, "git")).toContain('branch "feat/test"');
    f.probes.gitState = async () => ({ inside: true, detached: true });
    expect(find((await diagnose(f.options)).lines, "git")).toContain("HEAD is detached");
    f.probes.gitState = async () => ({ inside: false });
    expect(find((await diagnose(f.options)).lines, "git")).toContain("not inside");
  });

  it("does not turn an unavailable informational Git probe into a failure", async () => {
    const f = fixture();
    f.probes.gitState = async () => { throw new Error("git absent"); };
    expect(find((await diagnose(f.options)).lines, "git")).toContain("skip git");
  });

  it("reports TUI availability for two TTYs and headless-only otherwise", async () => {
    const f = fixture();
    expect(find((await diagnose(f.options)).lines, "tty")).toContain("interactive TUI is available");
    const headless = await diagnose({ ...f.options, stdinTTY: false, stdoutTTY: false });
    expect(find(headless.lines, "tty")).toContain("headless-only, use agentrig run");
  });

  it("returns exit code zero when checks pass or skip and one for any failure", async () => {
    const passing = fixture();
    expect((await diagnose(passing.options)).exitCode).toBe(0);
    expect((await diagnose({ ...passing.options, env: {} })).exitCode).toBe(1);
  });

  it("does not leak an invalid enum value and skips credentials when config resolution failed", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "FABRICATED_ENUM_SECRET" }));
    const result = await diagnose(f.options);
    expect(find(result.lines, "config:user")).toContain("fix");
    expect(find(result.lines, "credentials")).toContain("effective provider is unknown");
    expect(result.lines.join("\n")).not.toContain("FABRICATED_ENUM_SECRET");
  });

  it("fails an unknown injected provider rather than treating it as ChatGPT", async () => {
    const f = fixture();
    const result = await diagnose({ ...f.options, cli: { provider: "surprise" as never } });
    expect(find(result.lines, "config:effective")).toContain("set --provider to anthropic, openai, or openai-chatgpt");
    expect(find(result.lines, "credentials")).toContain("effective provider is invalid");
  });

  it("fails OpenAI providers without an explicit model and names all model fixes", async () => {
    const f = fixture();
    for (const provider of ["openai", "openai-chatgpt"] as const) {
      f.files.set(USER_CONFIG, JSON.stringify({ provider }));
      const result = await diagnose({ ...f.options, env: { OPENAI_API_KEY: "present" } });
      expect(find(result.lines, "config:effective")).toContain("set --model, AGENTRIG_MODEL, or model in config");
      expect(result.exitCode).toBe(1);
    }
  });

  it("does not read config or trust paths when project-boundary resolution throws", async () => {
    const f = fixture();
    f.probes.boundary = async () => { throw new Error("boundary failed"); };
    const result = await diagnose(f.options);
    expect(find(result.lines, "trust")).toContain("fix permissions on the working directory");
    expect(f.reads).toEqual([]);
    expect(result.lines.filter((candidate) => candidate.startsWith("fail trust "))).toHaveLength(1);
  });

  it("requires the memory path to be a directory and its index to be a regular file", async () => {
    const f = fixture();
    f.probes.stat = async () => ({ isDirectory: () => false, isFile: () => false });
    const result = await diagnose(f.options);
    expect(find(result.lines, "memory")).toContain("not a writable directory");
    expect(find(result.lines, "memory:index")).toContain("not a readable file");
  });

  it("does not open a project-owned MCP config while the project is untrusted", async () => {
    const f = fixture();
    f.files.set(TRUST, JSON.stringify({ projects: { [ROOT]: false } }));
    f.files.set(join(ROOT, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const result = await diagnose({ ...f.options, cli: { mcpConfig: "mcp.json" } });
    expect(find(result.lines, "mcp")).toContain("skipped (untrusted)");
    expect(f.reads).not.toContain(join(ROOT, "mcp.json"));
  });

  it("default command lookup rejects a directory and accepts an executable regular file", async () => {
    const f = fixture();
    const dir = await mkdtemp(join(tmpdir(), "agentrig-command-"));
    cleanupDirs.push(dir);
    const executable = join(dir, "real-server");
    const directory = join(dir, "fake-server");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o700);
    await mkdir(directory);
    const mcp = join(ROOT, "mcp.json");
    delete (f.probes as Partial<DoctorProbes>).commandExists;
    f.files.set(mcp, JSON.stringify({ mcpServers: { real: { command: executable }, fake: { command: directory } } }));
    const result = await diagnose({ ...f.options, probes: f.probes, cli: { mcpConfig: mcp } });
    expect(find(result.lines, 'mcp:"real"')).toContain("pass");
    expect(find(result.lines, 'mcp:"fake"')).toContain("install it");
  });

  it("checks an MCP command with the server's env and cwd context", async () => {
    const f = fixture();
    const path = join(ROOT, "mcp.json");
    f.files.set(path, JSON.stringify({ mcpServers: { docs: { command: "server", env: { PATH: "tools" }, cwd: "service" } } }));
    let seen: { env: NodeJS.ProcessEnv; cwd: string } | undefined;
    f.probes.commandExists = async (_command, env, cwd) => { seen = { env, cwd }; return true; };
    await diagnose({ ...f.options, cli: { mcpConfig: path } });
    expect(seen).toEqual({ env: { ANTHROPIC_API_KEY: "fabricated-anthropic-secret", PATH: "tools" }, cwd: join(ROOT, "service") });
  });

  it("escapes terminal controls from dynamic profile, model, server, command, and branch values", async () => {
    const f = fixture();
    const marker = "evil\u001b[2J\nINJECTED";
    f.files.set(USER_CONFIG, JSON.stringify({ profiles: { [marker]: { model: marker } } }));
    f.files.set(join(ROOT, "mcp.json"), JSON.stringify({ mcpServers: { [marker]: { command: marker } } }));
    f.probes.gitState = async () => ({ inside: true, branch: marker });
    const result = await diagnose({ ...f.options, cli: { profile: marker, mcpConfig: join(ROOT, "mcp.json") } });
    const output = result.lines.join("\n");
    expect(output).not.toContain("\u001b");
    expect(result.lines.every((candidate) => !candidate.includes("\n"))).toBe(true);
    expect(output).toContain("\\u001b[2J\\nINJECTED");
  });

  it("is deterministic when probes return the same state", async () => {
    const f = fixture();
    const first = await diagnose(f.options);
    const second = await diagnose(f.options);
    expect(second).toEqual(first);
  });
});

describe("named provider entries (R3.5a)", () => {
  const config = {
    providers: {
      cloud: { provider: "openai-chatgpt", model: "gpt-5.6-sol" },
      local: { provider: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.8-27b" },
    },
    roles: { main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" },
  };

  it("checks each entry's credential by its own kind and prints the role table", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify(config));
    const result = await diagnose({ ...f.options, env: { ANTHROPIC_API_KEY: "x" } });
    expect(find(result.lines, "providers:local")).toContain("pass providers:local");
    expect(find(result.lines, "providers:local")).toContain("OPENAI_API_KEY is not required");
    expect(find(result.lines, "providers:cloud")).toContain("fail providers:cloud");
    expect(find(result.lines, "providers:cloud")).toContain("agentrig login openai-chatgpt");
    expect(find(result.lines, "providers:roles")).toContain("main→cloud, supervisor→cloud, memory→cloud, subagents→local");
  });

  it("fails the role table when a role names a missing entry", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ ...config, roles: { memory: "wiki" } }));
    const result = await diagnose({ ...f.options, env: { ANTHROPIC_API_KEY: "x" } });
    expect(find(result.lines, "providers:roles")).toContain("fail providers:roles");
    expect(find(result.lines, "providers:roles")).toContain('role memory names unknown provider entry "wiki"');
    expect(result.exitCode).toBe(1);
  });

  it("prints no provider entry lines when config has no providers block", async () => {
    const result = await diagnose(fixture().options);
    expect(result.lines.some((l) => l.includes("providers:"))).toBe(false);
  });

  it("pins main to the default entry when a provider flag is typed, exactly as run does", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify(config));
    const result = await diagnose({ ...f.options, env: { ANTHROPIC_API_KEY: "x" }, cli: { model: "typed" } });
    expect(find(result.lines, "providers:roles")).toContain("main→default, supervisor→cloud, memory→cloud, subagents→local");
  });

  it("skips the flat default's credential when no role uses it, without failing a config that runs fine (I2)", async () => {
    const f = fixture();
    // both entries are keyless-local-style so the whole diagnosis can be green: neither role
    // resolves to `default`, and the flat default (anthropic, no ANTHROPIC_API_KEY here) would
    // otherwise fail a config `agentrig run` starts cleanly.
    const keylessConfig = {
      providers: {
        cloud: { provider: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "cloud-model" },
        local: { provider: "openai", baseUrl: "http://127.0.0.1:9090/v1", model: "local-model" },
      },
      roles: { main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" },
    };
    f.files.set(USER_CONFIG, JSON.stringify(keylessConfig));
    const result = await diagnose({ ...f.options, env: {} });
    expect(find(result.lines, "credentials")).toContain("skip credentials");
    expect(find(result.lines, "credentials")).toContain("not used by any role");
    expect(find(result.lines, "providers:roles")).toContain("pass");
    expect(result.exitCode).toBe(0);
  });

  it("diagnoses a roles block with no providers block at all (I3)", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ roles: { main: "cloud" } }));
    const result = await diagnose({ ...f.options, env: { ANTHROPIC_API_KEY: "x" } });
    expect(find(result.lines, "providers:roles")).toContain("fail providers:roles");
    expect(find(result.lines, "providers:roles")).toContain('role main names unknown provider entry "cloud"');
    expect(result.exitCode).toBe(1);
  });
});

describe("doctor read-only guarantee", () => {
  const cleanup: string[] = [];

  async function snapshot(root: string, relative = ""): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) Object.assign(result, await snapshot(root, name));
      else if (entry.isFile()) result[name] = await readFile(join(root, name), "utf8");
    }
    return result;
  }
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("does not change any config, trust, token, memory, or MCP file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrig-doctor-root-"));
    const home = await mkdtemp(join(tmpdir(), "agentrig-doctor-home-"));
    cleanup.push(root, home);
    await mkdir(join(home, ".agentrig"), { recursive: true });
    await mkdir(join(root, ".agentrig", "wiki"), { recursive: true });
    const auth = join(home, ".agentrig", "auth.json");
    const mcp = join(home, ".agentrig", "mcp.json");
    const token = `x.${Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url")}.x`;
    await writeFile(join(home, ".agentrig", "trust.json"), JSON.stringify({ projects: { [root]: true } }));
    await writeFile(join(home, ".agentrig", "config.json"), JSON.stringify({ provider: "openai-chatgpt", model: "gpt", memory: join(root, ".agentrig"), mcpConfig: mcp }));
    await writeFile(join(root, ".agentrig", "config.json"), JSON.stringify({ maxTurns: 3 }));
    await writeFile(join(root, ".agentrig", "wiki", "index.md"), "# index\n");
    await writeFile(auth, JSON.stringify({ accessToken: token, refreshToken: "FABRICATED_REFRESH" }));
    await writeFile(mcp, JSON.stringify({ mcpServers: {} }));
    const before = { home: await snapshot(home), root: await snapshot(root) };
    await diagnose({
      cwd: root,
      home,
      env: { AGENTRIG_OPENAI_CHATGPT_AUTH: auth },
      now: () => 1_700_000_000_000,
      probes: {
        boundary: async () => ({ projectRoot: root, userStateSafe: true }),
        gitState: async () => ({ inside: false }),
      },
    });
    expect({ home: await snapshot(home), root: await snapshot(root) }).toEqual(before);
  });

  it("does not change an existing trust.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrig-doctor-root-"));
    const home = await mkdtemp(join(tmpdir(), "agentrig-doctor-home-"));
    cleanup.push(root, home);
    const trustPath = join(home, ".agentrig", "trust.json");
    await mkdir(join(home, ".agentrig"));
    const original = `${JSON.stringify({ projects: { [root]: false } }, null, 2)}\n`;
    await writeFile(trustPath, original, "utf8");
    await diagnose({
      cwd: root,
      home,
      env: { ANTHROPIC_API_KEY: "present" },
      probes: {
        boundary: async () => ({ projectRoot: root, userStateSafe: true }),
        access: async () => undefined,
        gitState: async () => ({ inside: false }),
      },
    });
    expect(await readFile(trustPath, "utf8")).toBe(original);
  });

  it("leaves trust.json absent for an undecided project and never prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrig-doctor-root-"));
    const home = await mkdtemp(join(tmpdir(), "agentrig-doctor-home-"));
    cleanup.push(root, home);
    const trustPath = join(home, ".agentrig", "trust.json");
    const result = await diagnose({
      cwd: root,
      home,
      env: { ANTHROPIC_API_KEY: "present" },
      stdinTTY: true,
      stdoutTTY: true,
      probes: {
        boundary: async () => ({ projectRoot: root, userStateSafe: true }),
        access: async () => undefined,
        gitState: async () => ({ inside: false }),
      },
    });
    expect(find(result.lines, "trust")).toContain("undecided");
    await expect(access(trustPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
