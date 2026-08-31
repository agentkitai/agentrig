import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ChatGPTTokens, decodeJwtClaims, tokensFromEnvValue } from "@agentkitai/agentrig-core";
import { parseMcpConfigText } from "./agent-builder.js";
import { parseConfigText, resolveConfig, type ConfigFile, type ConfigValues } from "./config.js";
import { DEFAULT_ANTHROPIC_MODEL } from "./provider.js";
import { resolveProjectBoundary, type ProjectBoundary } from "./trust.js";

const execFileAsync = promisify(execFile);
const OPAQUE_TOKEN_MAX_AGE_MS = 45 * 60_000;

export interface DoctorCliValues extends Partial<ConfigValues> {
  profile?: string;
}

export interface DoctorGitState {
  inside: boolean;
  branch?: string;
  detached?: boolean;
}

export interface DoctorProbes {
  readFile(path: string): Promise<string>;
  access(path: string, mode: number): Promise<void>;
  boundary(cwd: string, home: string): Promise<ProjectBoundary>;
  commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean>;
  gitState(cwd: string): Promise<DoctorGitState>;
}

export interface DoctorOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  cli?: DoctorCliValues;
  probes?: Partial<DoctorProbes>;
}

export interface DoctorResult {
  lines: string[];
  exitCode: 0 | 1;
}

type Status = "pass" | "fail" | "skip";
interface CheckLine { status: Status; label: string; detail: string }

function line(status: Status, label: string, detail: string): CheckLine {
  return { status, label, detail };
}

function enoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function defaultCommandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates: string[] = [];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    for (const extension of extensions) candidates.push(`${command}${extension}`);
  } else {
    for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const extension of extensions) candidates.push(join(directory, `${command}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch { /* keep searching */ }
  }
  return false;
}

async function defaultGitState(cwd: string): Promise<DoctorGitState> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    return { inside: false };
  }
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
    return { inside: true, branch: stdout.trim(), detached: false };
  } catch {
    return { inside: true, detached: true };
  }
}

function defaultProbes(): DoctorProbes {
  return {
    readFile: (path) => readFile(path, "utf8"),
    access,
    boundary: resolveProjectBoundary,
    commandExists: defaultCommandExists,
    gitState: defaultGitState,
  };
}

function selected(file: ConfigFile | undefined, profile: string | undefined): ConfigValues | undefined {
  return profile === undefined ? undefined : file?.profiles?.[profile];
}

function sourceOf(
  key: keyof ConfigValues,
  user: ConfigFile | undefined,
  project: ConfigFile | undefined,
  profile: string | undefined,
  env: NodeJS.ProcessEnv,
  cli: DoctorCliValues,
): string {
  if (cli[key] !== undefined) return "CLI flag";
  if (key === "model" && env.AGENTRIG_MODEL !== undefined) return "AGENTRIG_MODEL";
  if (selected(project, profile)?.[key] !== undefined) return `project profile ${profile}`;
  if (project?.[key] !== undefined) return "project config";
  if (selected(user, profile)?.[key] !== undefined) return `user profile ${profile}`;
  if (user?.[key] !== undefined) return "user config";
  return "built-in default";
}

function expiry(tokens: ChatGPTTokens): number | null {
  const exp = decodeJwtClaims(tokens.accessToken)?.["exp"];
  if (typeof exp === "number") return exp * 1000;
  return tokens.lastRefresh === undefined ? null : tokens.lastRefresh + OPAQUE_TOKEN_MAX_AGE_MS;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

async function readOptionalConfig(path: string, probes: DoctorProbes): Promise<{ file?: ConfigFile; check: CheckLine }> {
  let text: string;
  try {
    text = await probes.readFile(path);
  } catch (error) {
    if (enoent(error)) return { check: line("skip", path, "not present; this layer has no overrides") };
    return { check: line("fail", path, `cannot be read; fix permissions on ${path}`) };
  }
  try {
    return { file: parseConfigText(path, text), check: line("pass", path, "parses and validates") };
  } catch {
    return { check: line("fail", path, `invalid; fix ${path} (run with a valid JSON config and no credentials in it)`) };
  }
}

async function readTrust(
  boundary: ProjectBoundary,
  home: string,
  probes: DoctorProbes,
): Promise<{ trusted: boolean; status: "trusted" | "untrusted" | "undecided"; check: CheckLine }> {
  const fix = "run agentrig with --trust or answer the trust prompt interactively";
  if (!boundary.userStateSafe) {
    return { trusted: false, status: "untrusted", check: line("fail", "trust", `untrusted because the project contains the user state directory; ${fix}`) };
  }
  const path = join(home, ".agentrig", "trust.json");
  let text: string;
  try {
    text = await probes.readFile(path);
  } catch (error) {
    if (enoent(error)) return { trusted: false, status: "undecided", check: line("fail", "trust", `undecided; project config and instructions are skipped — ${fix}`) };
    return { trusted: false, status: "undecided", check: line("fail", "trust", `undecided because the trust store is unreadable; fix permissions on ${path}, then ${fix}`) };
  }
  let projects: unknown;
  try {
    projects = (JSON.parse(text) as { projects?: unknown }).projects;
  } catch {
    return { trusted: false, status: "undecided", check: line("fail", "trust", `undecided because the trust store is malformed; fix ${path}, then ${fix}`) };
  }
  if (projects === null || typeof projects !== "object" || Array.isArray(projects)) {
    return { trusted: false, status: "undecided", check: line("fail", "trust", `undecided because the trust store is malformed; fix ${path}, then ${fix}`) };
  }
  const decision = (projects as Record<string, unknown>)[boundary.projectRoot];
  if (decision === true) return { trusted: true, status: "trusted", check: line("pass", "trust", "trusted; project config and instructions may load") };
  if (decision === false) return { trusted: false, status: "untrusted", check: line("fail", "trust", `untrusted; project config and instructions are skipped — ${fix}`) };
  return { trusted: false, status: "undecided", check: line("fail", "trust", `undecided; project config and instructions are skipped — ${fix}`) };
}

async function credentialCheck(
  effective: ConfigValues & Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  home: string,
  now: number,
  probes: DoctorProbes,
): Promise<CheckLine> {
  const provider = effective.provider ?? "anthropic";
  if (provider === "anthropic") {
    return env.ANTHROPIC_API_KEY
      ? line("pass", "credentials", "provider anthropic; ANTHROPIC_API_KEY is present (environment)")
      : line("fail", "credentials", "provider anthropic; ANTHROPIC_API_KEY is absent — set ANTHROPIC_API_KEY");
  }
  if (provider === "openai") {
    if (effective.baseUrl !== undefined && !env.OPENAI_API_KEY) {
      return line("skip", "credentials", "provider openai with a custom base URL; OPENAI_API_KEY is not required by AgentRig")
    }
    return env.OPENAI_API_KEY
      ? line("pass", "credentials", "provider openai; OPENAI_API_KEY is present (environment)")
      : line("fail", "credentials", "provider openai; OPENAI_API_KEY is absent — set OPENAI_API_KEY");
  }
  const authPath = env.AGENTRIG_OPENAI_CHATGPT_AUTH ?? join(home, ".agentrig", "openai-chatgpt-auth.json");
  let tokens: ChatGPTTokens | null = null;
  let source = "";
  try {
    const raw = await probes.readFile(authPath);
    const parsed = ChatGPTTokens.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.refreshToken !== "") {
      tokens = parsed.data;
      source = `token store ${authPath}`;
    }
  } catch { /* env is the read-only fallback; never surface parser or filesystem errors */ }
  if (tokens === null && env.AGENTRIG_OPENAI_CHATGPT_TOKEN !== undefined) {
    tokens = tokensFromEnvValue(env.AGENTRIG_OPENAI_CHATGPT_TOKEN);
    source = "AGENTRIG_OPENAI_CHATGPT_TOKEN";
  }
  const fix = "run agentrig login openai-chatgpt";
  if (tokens === null) return line("fail", "credentials", `provider openai-chatgpt; no readable valid token bundle — ${fix}`);
  const expiresAt = expiry(tokens);
  if (expiresAt === null) return line("fail", "credentials", `provider openai-chatgpt; token expiry cannot be established from ${source} — ${fix}`);
  if (expiresAt <= now) return line("fail", "credentials", `provider openai-chatgpt; token from ${source} expired ${duration(now - expiresAt)} ago — ${fix}`);
  return line("pass", "credentials", `provider openai-chatgpt; token store readable from ${source}; expires in ${duration(expiresAt - now)}`);
}

export async function diagnose(options: DoctorOptions = {}): Promise<DoctorResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const cli = options.cli ?? {};
  const probes = { ...defaultProbes(), ...options.probes };
  const checks: CheckLine[] = [];

  let boundary: ProjectBoundary;
  try {
    boundary = await probes.boundary(cwd, home);
  } catch {
    checks.push(line("fail", "trust", "cannot determine the project boundary; fix permissions on the working directory, then rerun agentrig doctor"));
    boundary = { projectRoot: cwd, userStateSafe: false };
  }
  const trust = await readTrust(boundary, home, probes);
  checks.push(trust.check);

  const userPath = join(home, ".agentrig", "config.json");
  let user: ConfigFile | undefined;
  let configInvalid = false;
  if (!boundary.userStateSafe) {
    checks.push(line("skip", "config:user", "skipped because the user state directory is inside the project boundary"));
  } else {
    const loaded = await readOptionalConfig(userPath, probes);
    user = loaded.file;
    configInvalid ||= loaded.check.status === "fail";
    checks.push({ ...loaded.check, label: "config:user" });
  }

  let project: ConfigFile | undefined;
  const projectPath = join(boundary.projectRoot, ".agentrig", "config.json");
  if (!trust.trusted) {
    checks.push(line("skip", "config:project", `skipped (untrusted) — trust state is ${trust.status}; file was not opened`));
  } else {
    const loaded = await readOptionalConfig(projectPath, probes);
    project = loaded.file;
    configInvalid ||= loaded.check.status === "fail";
    checks.push({ ...loaded.check, label: "config:project" });
  }

  const profile = cli.profile;
  if (profile === undefined) {
    checks.push(line("skip", "config:profile", "no active profile selected"));
  } else if (user?.profiles?.[profile] !== undefined || project?.profiles?.[profile] !== undefined) {
    checks.push(line("pass", "config:profile", `active profile ${JSON.stringify(profile)} exists`));
  } else {
    configInvalid = true;
    checks.push(line("fail", "config:profile", `active profile ${JSON.stringify(profile)} does not exist — add it under profiles or remove --profile ${profile}`));
  }

  let effective: ConfigValues & Record<string, unknown> = { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL };
  if (configInvalid) {
    checks.push(line("fail", "config:effective", "precedence cannot be trusted while config is invalid — fix the failed config line above"));
  } else {
    effective = resolveConfig({
      defaults: { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL, memory: ".agentrig" },
      ...(user === undefined ? {} : { user }),
      ...(project === undefined ? {} : { project }),
      ...(env.AGENTRIG_MODEL === undefined ? {} : { env: { model: env.AGENTRIG_MODEL } }),
      cli,
      ...(profile === undefined ? {} : { profile }),
    });
    const provider = effective.provider ?? "anthropic";
    const model = effective.model ?? DEFAULT_ANTHROPIC_MODEL;
    checks.push(line("pass", "config:effective", `provider ${provider} from ${sourceOf("provider", user, project, profile, env, cli)}; model ${model} from ${sourceOf("model", user, project, profile, env, cli)}`));
  }

  checks.push(await credentialCheck(effective, env, home, now, probes));

  const memory = typeof effective.memory === "string" ? resolve(cwd, effective.memory) : undefined;
  if (memory === undefined) {
    checks.push(line("skip", "memory", "no memory directory is configured"));
    checks.push(line("skip", "memory:index", "no memory directory is configured"));
  } else {
    try {
      await probes.access(memory, constants.F_OK | constants.W_OK);
      checks.push(line("pass", "memory", `${memory} exists and is writable`));
    } catch {
      checks.push(line("fail", "memory", `${memory} is missing or not writable — run agentrig memory init --dir ${memory} and fix directory permissions`));
    }
    const index = join(memory, "wiki", "index.md");
    try {
      await probes.access(index, constants.R_OK);
      checks.push(line("pass", "memory:index", `${index} is readable`));
    } catch {
      checks.push(line("fail", "memory:index", `${index} is missing or unreadable — run agentrig memory init --dir ${memory} and fix file permissions`));
    }
  }

  const mcpPath = typeof effective.mcpConfig === "string" ? resolve(cwd, effective.mcpConfig) : undefined;
  if (mcpPath === undefined) {
    checks.push(line("skip", "mcp", "no MCP config is configured"));
  } else {
    let servers: ReturnType<typeof parseMcpConfigText> | undefined;
    try {
      servers = parseMcpConfigText(mcpPath, await probes.readFile(mcpPath));
      checks.push(line("pass", "mcp", `${mcpPath} parses (${servers.length} server${servers.length === 1 ? "" : "s"})`));
    } catch {
      checks.push(line("fail", "mcp", `${mcpPath} cannot be read or parsed — fix --mcp-config ${mcpPath}`));
    }
    for (const server of servers ?? []) {
      let exists = false;
      try { exists = await probes.commandExists(server.command, env); } catch { exists = false; }
      checks.push(exists
        ? line("pass", `mcp:${server.name}`, `command ${JSON.stringify(server.command)} exists on PATH`)
        : line("fail", `mcp:${server.name}`, `command ${JSON.stringify(server.command)} is unavailable — install it or put ${server.command} on PATH`));
    }
  }

  try {
    const git = await probes.gitState(cwd);
    checks.push(!git.inside
      ? line("pass", "git", "not inside a Git repository (informational)")
      : git.detached === true
        ? line("pass", "git", "inside a Git repository; HEAD is detached (informational)")
        : line("pass", "git", `inside a Git repository; branch ${git.branch ?? "unknown"} (informational)`));
  } catch {
    checks.push(line("skip", "git", "Git state unavailable (informational only)"));
  }

  const stdinTTY = options.stdinTTY ?? process.stdin.isTTY === true;
  const stdoutTTY = options.stdoutTTY ?? process.stdout.isTTY === true;
  checks.push(stdinTTY && stdoutTTY
    ? line("pass", "tty", "stdin TTY yes; stdout TTY yes; interactive TUI is available")
    : line("skip", "tty", `stdin TTY ${stdinTTY ? "yes" : "no"}; stdout TTY ${stdoutTTY ? "yes" : "no"}; headless-only, use agentrig run`));

  return {
    lines: checks.map((check) => `${check.status} ${check.label} — ${check.detail}`),
    exitCode: checks.some((check) => check.status === "fail") ? 1 : 0,
  };
}
