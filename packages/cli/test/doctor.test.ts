import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnose, type DoctorOptions, type DoctorProbes } from "../src/doctor.ts";
import { buildProgram } from "../src/program.ts";

const HOME = "/home/tester";
const ROOT = "/work/project";
const TRUST = join(HOME, ".agentrig", "trust.json");
const USER_CONFIG = join(HOME, ".agentrig", "config.json");
const PROJECT_CONFIG = join(ROOT, ".agentrig", "config.json");

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
    expect(find(result.lines, "credentials")).toMatch(/token store readable.*expires in 10m/);
    expect(result.lines.join("\n")).not.toContain(secret);
    expect(result.lines.join("\n")).not.toContain("FABRICATED_SECRET");
  });

  it("fails an expired ChatGPT token and names login as the fix", async () => {
    const f = fixture();
    const token = `x.${Buffer.from(JSON.stringify({ exp: 1_699_999_000 })).toString("base64url")}.x`;
    f.files.set(USER_CONFIG, JSON.stringify({ provider: "openai-chatgpt", model: "gpt-test" }));
    f.files.set(join(HOME, ".agentrig", "openai-chatgpt-auth.json"), JSON.stringify({ accessToken: token, refreshToken: "refresh" }));
    const result = await diagnose({ ...f.options, env: {} });
    expect(find(result.lines, "credentials")).toContain("run agentrig login openai-chatgpt");
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
    expect(find(result.lines, "config:user")).toContain(`fix ${USER_CONFIG}`);
    expect(result.lines.join("\n")).not.toContain("FABRICATED_CONFIG_SECRET");
  });

  it("fails malformed trusted project config with a named repair", async () => {
    const f = fixture();
    f.files.set(PROJECT_CONFIG, "not-json");
    const result = await diagnose(f.options);
    expect(find(result.lines, "config:project")).toContain(`fix ${PROJECT_CONFIG}`);
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

  it("passes an active profile and fails an absent one with the fix named", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ profiles: { work: { model: "work-model" } } }));
    let result = await diagnose({ ...f.options, cli: { profile: "work" } });
    expect(find(result.lines, "config:profile")).toContain("pass");
    result = await diagnose({ ...f.options, cli: { profile: "missing" } });
    expect(find(result.lines, "config:profile")).toContain("add it under profiles or remove --profile missing");
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
    expect(find(result.lines, "config:effective")).toContain("provider openai-chatgpt from project config; model cli-model from CLI flag");
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
    expect(find(result.lines, "memory")).toContain("exists and is writable");
    expect(find(result.lines, "memory:index")).toContain("is readable");
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
    expect(find(result.lines, "mcp:docs")).toContain("exists on PATH");
  });

  it("fails malformed MCP config with its repair flag and redacts env values", async () => {
    const f = fixture();
    const path = join(ROOT, "mcp.json");
    f.files.set(path, `{ "mcpServers": { "x": { "env": { "TOKEN": "MCP_SECRET" } } }`);
    const result = await diagnose({ ...f.options, cli: { mcpConfig: path } });
    expect(find(result.lines, "mcp")).toContain(`fix --mcp-config ${path}`);
    expect(result.lines.join("\n")).not.toContain("MCP_SECRET");
  });

  it("fails a missing MCP server command with install/PATH as the named fix", async () => {
    const f = fixture();
    const path = join(ROOT, "mcp.json");
    f.files.set(path, JSON.stringify({ mcpServers: { docs: { command: "missing-server" } } }));
    f.probes.commandExists = async () => false;
    const result = await diagnose({ ...f.options, cli: { mcpConfig: path } });
    expect(find(result.lines, "mcp:docs")).toContain("install it or put missing-server on PATH");
  });

  it("reports Git branch, detached HEAD, and outside-repository states as informational", async () => {
    const f = fixture();
    expect(find((await diagnose(f.options)).lines, "git")).toContain("branch feat/test");
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

  it("is deterministic when probes return the same state", async () => {
    const f = fixture();
    const first = await diagnose(f.options);
    const second = await diagnose(f.options);
    expect(second).toEqual(first);
  });
});

describe("doctor read-only guarantee", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
