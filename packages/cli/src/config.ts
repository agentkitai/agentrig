import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { CommandPrefixSchema, DiagnosticsConfigSchema, REASONING_EFFORTS } from "@agentkitai/agentrig-core";
import { DreamLimitsSchema, IngestLimitsSchema, ScanLimitsSchema } from "@agentkitai/agentrig-memory";
import { resolveProjectBoundary, resolveProjectTrust } from "./trust.js";
import { NotificationMode, NotificationIdleSeconds } from "./tui/notifications.js";
import { TuiSettingsSchema } from "./tui/settings.js";

// Re-exported so downstream CLI code imports the reasoning-effort type from one place.
export type { ReasoningEffort } from "@agentkitai/agentrig-core";

const positiveSetting = z
  .union([z.string().min(1), z.number().finite()])
  .transform(String)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, "must be a positive number");
const integerSetting = positiveSetting.refine((value) => Number.isInteger(Number(value)), "must be a positive integer");
/** The role runtime requires an exactly representable positive turn count. */
export const SubagentTurnLimitSchema = positiveSetting.refine(value => Number.isSafeInteger(Number(value)), "must be a positive safe integer");
const softSetting = z
  .union([z.string().min(1), z.number().finite()])
  .transform(String)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1, "must be greater than 0 and at most 1");
const stringList = z.array(z.string().min(1));

const ProviderKindSchema = z.enum(["anthropic", "openai", "openai-chatgpt"]);
export type ProviderKind = z.output<typeof ProviderKindSchema>;
const reasoningEffortSetting = z.enum(REASONING_EFFORTS);
// deliberately a number, not a numeric string like the settings above: the adapter needs a number
const contextWindowSetting = z.number().int().positive();
const providerModelName = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u, "model names must be control-free");

/** One named provider entry. Credentials never appear here; they come from the environment per kind. */
export const ProviderEntrySchema = z
  .object({
    provider: ProviderKindSchema,
    model: providerModelName,
    baseUrl: z.string().url().optional(),
    contextWindow: contextWindowSetting.optional(),
    reasoningEffort: reasoningEffortSetting.optional(),
  })
  .strict();
export type ProviderEntry = z.output<typeof ProviderEntrySchema>;

export const ROLES = ["main", "supervisor", "memory", "subagents"] as const;
export type Role = (typeof ROLES)[number];
const roleName = z.string().min(1).max(128).optional();
// Bound to `Role` at compile time (`satisfies Record<Role, typeof roleName>`): a fifth role added
// to ROLES without a matching key here is a type error, not a silent gap.
const RolesSchema = z
  .object({ main: roleName, supervisor: roleName, memory: roleName, subagents: roleName } satisfies Record<
    Role,
    typeof roleName
  >)
  .strict();
export type Roles = z.output<typeof RolesSchema>;

const ENTRY_NAME = /^[a-z][a-z0-9-]*$/;
const providersSetting = z.record(ProviderEntrySchema).superRefine((entries, ctx) => {
  for (const name of Object.keys(entries)) {
    if (name === "default") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'the entry name "default" is reserved for the flat provider/model keys' });
    } else if (name.length > 128 || !ENTRY_NAME.test(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "entry names must be at most 128 characters and match ^[a-z][a-z0-9-]*$" });
    }
  }
});

/**
 * Values that are useful across runs. Output types intentionally match Commander's option types,
 * so config resolution is the only extra layer and the existing validation/build path stays shared.
 * Output-only flags (json/verbose/headless), tasks and resume ids are deliberately not config.
 */
const ConfigValuesSchema = z
  .object({
    provider: ProviderKindSchema.optional(),
    model: providerModelName.optional(),
    baseUrl: z.string().url().optional(),
    contextWindow: contextWindowSetting.optional(),
    reasoningEffort: reasoningEffortSetting.optional(),
    providers: providersSetting.optional(),
    roles: RolesSchema.optional(),
    memory: z.string().min(1).optional(),
    root: z.string().min(1).optional(),
    system: z.string().min(1).optional(),
    allow: stringList.optional(),
    allowCommand: z.array(CommandPrefixSchema).max(128).optional(),
    deny: stringList.optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    yolo: z.boolean().optional(),
    sandbox: z.enum(["read-only", "workspace-write", "none"]).optional(),
    sandboxNetwork: z.boolean().optional(),
    checkpoints: z.boolean().optional(),
    diagnostics: DiagnosticsConfigSchema.optional(),
    notifications: NotificationMode.optional(),
    toolSummaries: z.boolean().optional(),
    tui: TuiSettingsSchema.optional(),
    notificationIdleSeconds: NotificationIdleSeconds.optional(),
    driftScope: stringList.optional(),
    driftContract: stringList.optional(),
    supervise: z.boolean().optional(),
    supervisorAbort: z.boolean().optional(),
    supervisorAbortRestores: z.boolean().optional(),
    supervisorSoft: softSetting.optional(),
    supervisorTurnsRemaining: integerSetting.optional(),
    supervisorReview: z.boolean().optional(),
    maxTurns: positiveSetting.optional(),
    maxTokens: positiveSetting.optional(),
    maxMinutes: positiveSetting.optional(),
    maxUsd: positiveSetting.optional(),
    dailyCap: positiveSetting.refine(value => Number(value) <= 1_000_000 && Number(value) >= 0.000001, "must be from 0.000001 to 1000000 USD").optional(),
    priceIn: positiveSetting.optional(),
    priceOut: positiveSetting.optional(),
    priceCacheRead: positiveSetting.optional(),
    priceCacheWrite: positiveSetting.optional(),
    maxTokensPerTurn: positiveSetting.optional(),
    ingestOnEnd: z.boolean().optional(),
    ingestLimits: IngestLimitsSchema.optional(),
    ingestSpanChars: integerSetting.refine(value => Number(value) >= 2 && Number(value) <= 2_147_483_647, "must be from 2 to 2147483647").optional(),
    dreamOnEnd: z.boolean().optional(),
    dreamEverySessions: positiveSetting.optional(),
    dreamEveryHours: positiveSetting.optional(),
    heartbeatMaxTurns: integerSetting.refine(value => Number(value) <= 50, "must be at most 50").optional(),
    dreamStructuralOnly: z.boolean().optional(),
    dreamScanLimits: ScanLimitsSchema.partial().optional(),
    dreamLimits: DreamLimitsSchema.optional(),
    mcpConfig: z.string().min(1).optional(),
    subagents: z.boolean().optional(),
    subagentMaxTurns: SubagentTurnLimitSchema.optional(),
    subagentMaxChildren: positiveSetting.optional(),
    skills: stringList.optional(),
    extension: stringList.max(32).optional(),
    extensionDiscovery: z.boolean().optional(),
    packages: z.boolean().optional(),
    /** Auto-load conventional `.agentrig/skills` directories (trusted project + home). Default on. */
    skillDiscovery: z.boolean().optional(),
    /** Include selected-memory and safe-home generated roots. Default off; no benefit claim. */
    generatedSkills: z.boolean().optional(),
    shell: z.string().min(1).optional(),
    repoMap: z.boolean().optional(),
  })
  .strict();

export type ConfigValues = z.output<typeof ConfigValuesSchema>;

const ConfigFileSchema = ConfigValuesSchema.extend({
  profiles: z.record(ConfigValuesSchema).optional(),
});
export type ConfigFile = z.output<typeof ConfigFileSchema>;

const CONFIG_KEYS = new Set(Object.keys(ConfigValuesSchema.shape));
/** Revalidate resolved launch values for read-only diagnostics, excluding runtime-only flags. */
export function diagnosticConfigValues(values: object): ConfigValues {
  return ConfigValuesSchema.parse(Object.fromEntries(Object.entries(values).filter(([key, value]) => CONFIG_KEYS.has(key) && value !== undefined)));
}
const CREDENTIAL_KEY = /^(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|secret|client[-_]?secret|password|credential|credentials|private[-_]?key)$/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function credentialPath(value: unknown, path: string[] = []): string[] | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = credentialPath(value[i], [...path, String(i)]);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = [...path, key];
    // Profile and provider-entry names are labels, not setting keys; a profile or entry named
    // "secret" carries no secret. Their VALUES are still walked. But the exemption is for the
    // NAME only: a key here whose value is a bare primitive (`{ "providers": { "apiKey": "sk-…" } }`)
    // is not a label at all, and must still go through the normal credential test.
    const parentIsLabelMap =
      path.length >= 1 && (path[path.length - 1] === "profiles" || path[path.length - 1] === "providers") && isPlainObject(child);
    if (!parentIsLabelMap && CREDENTIAL_KEY.test(key)) return next;
    const found = credentialPath(child, next);
    if (found !== null) return found;
  }
  return null;
}

function issueField(issue: z.ZodIssue | undefined): string {
  if (issue === undefined) return "<root>";
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return [...issue.path, issue.keys[0]].join(".");
  }
  return issue.path.length === 0 ? "<root>" : issue.path.join(".");
}

/** Zod enum errors embed the rejected value; only schema-authored text may cross this boundary. */
function safeIssueMessage(issue: z.ZodIssue | undefined): string {
  if (issue === undefined) return "invalid value";
  if (issue.code === "invalid_type") return `Expected ${issue.expected}`;
  if (issue.code === "custom") return issue.message;
  if (issue.code === "invalid_string") return `Invalid ${issue.validation}`;
  if (issue.code === "too_small") return issue.message;
  if (issue.code === "too_big") return issue.message;
  if (issue.code === "unrecognized_keys") return "Unrecognized setting";
  return "invalid value";
}

/** Parse one config without echoing its contents in an error (credentials may be present by mistake). */
export function parseConfigText(path: string, text: string): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Recent JSON.parse implementations include source context. Never copy that into diagnostics.
    throw new Error(`invalid config ${path} at <json>: malformed JSON`);
  }

  const credential = credentialPath(raw);
  if (credential !== null) {
    throw new Error(
      `invalid config ${path} at ${credential.join(".")}: credentials cannot be stored in config; keys belong in environment variables or \`agentrig login\``,
    );
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid config ${path} at ${issueField(issue)}: ${safeIssueMessage(issue)}`);
  }
  return parsed.data;
}

/** Read and validate one config boundary. Missing files are the only errors ignored. */
export async function readConfigFile(path: string): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`could not read config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfigText(path, text);
}

export interface ResolveConfigInput<T extends Record<string, unknown>> {
  defaults: T;
  user?: ConfigFile;
  project?: ConfigFile;
  env?: Partial<ConfigValues>;
  cli?: Partial<ConfigValues>;
  profile?: string;
}

function withoutProfiles(file: ConfigFile | undefined): ConfigValues {
  if (file === undefined) return {};
  const { profiles: _profiles, ...values } = file;
  return values;
}

/**
 * Pure precedence contract: defaults < user base < user profile < project base < project profile
 * < environment < explicitly typed CLI flags. Objects and arrays are replaced, never appended.
 */
export function resolveConfig<T extends Record<string, unknown>>(input: ResolveConfigInput<T>): T & ConfigValues {
  const { defaults, user, project, env = {}, cli = {}, profile } = input;
  if (profile !== undefined) {
    const names = [...new Set([...Object.keys(user?.profiles ?? {}), ...Object.keys(project?.profiles ?? {})])].sort();
    if (!names.includes(profile)) {
      throw new Error(
        `unknown config profile ${JSON.stringify(profile)}; available profiles: ${names.length === 0 ? "(none)" : names.join(", ")}`,
      );
    }
  }

  return {
    ...defaults,
    ...withoutProfiles(user),
    ...(profile === undefined ? {} : user?.profiles?.[profile] ?? {}),
    ...withoutProfiles(project),
    ...(profile === undefined ? {} : project?.profiles?.[profile] ?? {}),
    ...env,
    ...cli,
  };
}

/** Only values whose Commander source is not `default` count as CLI overrides. */
export function explicitCliValues(cmd: Command, values: Record<string, unknown>): Partial<ConfigValues> {
  const explicit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (CONFIG_KEYS.has(key) && cmd.getOptionValueSource(key) !== "default" && value !== undefined) {
      explicit[key] = value;
    }
  }
  return explicit as Partial<ConfigValues>;
}

export interface LoadRunConfigOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Whether this entry point may ask for persistent project consent. */
  interactive?: boolean;
  confirmTrust?: (message: string) => Promise<boolean>;
  notice?: (message: string) => void;
}

/** Filesystem shell around the pure resolver; both agent entry points call this exact function. */
export async function loadRunConfig(
  cmd: Command,
  defaults: Record<string, unknown>,
  options: LoadRunConfigOptions = {},
): Promise<Record<string, unknown> & ConfigValues> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const environment = options.env ?? process.env;
  // Security boundary: classify path ownership before parsing config. Usually ~/.agentrig is safely
  // outside the checkout; if a repository is the home directory (or contains it), even the nominal
  // user config and trust record are project-controlled and must be ignored.
  const boundary = await resolveProjectBoundary(cwd, home);
  // Validate trusted user state before opening a prompt. Otherwise a rejected user-config read can
  // strand readline and persist consent for a run that already aborted.
  const user = boundary.userStateSafe
    ? await readConfigFile(join(home, ".agentrig", "config.json"))
    : undefined;
  const trust = await resolveProjectTrust(cwd, {
    home,
    interactive: options.interactive === true,
    explicitTrust: defaults.trust === true,
    ...(options.confirmTrust === undefined ? {} : { confirm: options.confirmTrust }),
    ...(options.notice === undefined ? {} : { notice: options.notice }),
  }, boundary);
  const project = trust.trusted
    ? await readConfigFile(join(trust.projectRoot, ".agentrig", "config.json"))
    : undefined;
  const profile = typeof defaults.profile === "string" ? defaults.profile : undefined;
  const cli = explicitCliValues(cmd, defaults);
  const selected = (file: ConfigFile | undefined): ConfigValues | undefined =>
    profile === undefined ? undefined : file?.profiles?.[profile];
  const configHas = (key: keyof ConfigValues): boolean =>
    user?.[key] !== undefined || selected(user)?.[key] !== undefined || project?.[key] !== undefined || selected(project)?.[key] !== undefined;
  const recommended = ["run", "tui", "resume", "acp", "web", "mcp-serve", "tick"].includes(cmd.name());
  const recommendedDefaults: ConfigValues = {
    supervise: true, checkpoints: true, ingestOnEnd: true, notifications: "bell", toolSummaries: true,
    diagnostics: DiagnosticsConfigSchema.parse([
      { parser: "tsc", extensions: [".ts", ".tsx", ".mts", ".cts"], executable: "tsc", args: ["--noEmit", "--pretty", "false"] },
      { parser: "ruff-json", extensions: [".py", ".pyi"], executable: "ruff", args: ["check", "--output-format=json", "--", "{path}"] },
    ]),
  };
  const resolved = resolveConfig({
    defaults: { ...defaults, ...(recommended ? recommendedDefaults : {}) },
    ...(user === undefined ? {} : { user }),
    ...(project === undefined ? {} : { project }),
    ...(environment.AGENTRIG_MODEL === undefined ? {} : { env: { model: environment.AGENTRIG_MODEL } }),
    cli,
    ...(profile === undefined || (profile === "recommended" && user?.profiles?.recommended === undefined && project?.profiles?.recommended === undefined) ? {} : { profile }),
  });
  // Keep tsc available even without a root project (including monorepos and JSONC
  // solutions). Existing execution/reporting yields honest unavailable/incomplete
  // diagnostics, rather than silently dropping the acceptance signal.
  if (recommended && !configHas("diagnostics") && cli.diagnostics === undefined) {
    const pythonProject = await Promise.all(["ruff.toml", ".ruff.toml", "pyproject.toml"].map(async name => {
      try { await readFile(join(cwd, name), "utf8"); return true; } catch { return false; }
    }));
    resolved.diagnostics = recommendedDefaults.diagnostics?.filter(check =>
      check.parser === "tsc" || pythonProject.some(Boolean));
  }
  let defaultHookNotice: string | undefined;
  if (recommended && resolved.sandbox !== undefined && resolved.sandbox !== "none") {
    // Do not launder explicit hook opt-ins into a successful enforcing-sandbox launch.
    const omitted: string[] = [];
    if (!configHas("checkpoints") && cli.checkpoints === undefined) { resolved.checkpoints = false; omitted.push("checkpoints"); }
    if (!configHas("ingestOnEnd") && cli.ingestOnEnd === undefined) { resolved.ingestOnEnd = false; omitted.push("session-end ingest"); }
    if (omitted.length) {
      defaultHookNotice = `recommended profile: omitted implicit ${omitted.join(" and ")} under enforcing sandbox ${resolved.sandbox}; explicit hook opt-ins retain the fail-closed startup error.`;
      // Protocol adapters redact arbitrary integration messages. This fixed profile notice
      // must still reach operator stderr (never protocol stdout), as well as a mounted UI.
      console.error(defaultHookNotice);
      options.notice?.(defaultHookNotice);
    }
  }
  // Issue #61: conventional skill directories are appended AFTER any explicit dirs, so explicit
  // ones shadow discovered ones (`discoverSkills` is first-root-wins, and a missing directory is
  // silently skipped there). Project skills are repo-controlled text that lands verbatim in the
  // system prompt catalogue, so they load only under the same trust decision as AGENTS.md and
  // project config; `~/.agentrig/skills` is skipped when the repository contains the home
  // directory (`userStateSafe`), for the same reason user config is ignored there.
  const explicitSkills = Array.isArray(resolved.skills) ? (resolved.skills as string[]) : [];
  const discoveredSkills = resolved.skillDiscovery === false
    ? []
    : [
        ...(trust.trusted ? [join(trust.projectRoot, ".agentrig", "skills")] : []),
        ...(boundary.userStateSafe ? [join(home, ".agentrig", "skills")] : []),
      ];
  // Generated skill discovery is a separate opt-in, not a permission/evidence receipt. Keep
  // explicit and ordinary roots first so enabling it cannot displace existing manual skills.
  // An explicitly selected memory directory follows the same cwd-relative rule as --memory;
  // the default belongs to the trusted project root even when invoked from a nested cwd.
  const selectedMemory = typeof resolved.memory === "string" && (cli.memory !== undefined || configHas("memory"))
    ? resolve(cwd, resolved.memory) : join(trust.projectRoot, ".agentrig");
  const generatedSkills = resolved.generatedSkills !== true || resolved.skillDiscovery === false ? [] : [
    ...(trust.trusted ? [join(selectedMemory, "skills", "generated")] : []),
    ...(boundary.userStateSafe ? [join(home, ".agentrig", "skills", "generated")] : []),
  ];
  return {
    ...resolved,
    ...(recommended ? { verbose: resolved.toolSummaries === false } : {}),
    ...(defaultHookNotice === undefined ? {} : { defaultHookNotice }),
    // Runtime option-source metadata: a shared default false is not a scheduled ingest opt-out.
    ingestOnEndExplicit: cli.ingestOnEnd !== undefined || configHas("ingestOnEnd"),
    superviseExplicit: cli.supervise !== undefined || configHas("supervise"),
    checkpointsExplicit: cli.checkpoints !== undefined || configHas("checkpoints"),
    // deduped: an explicit dir naming a conventional one would otherwise be scanned twice and
    // emit a per-skill shadowing warning every run
    skills: [...new Set([...explicitSkills, ...discoveredSkills, ...generatedSkills])],
    // Runtime-only insertion point; packages are verified in buildAgent, never by config data.
    packageSkillIndex: [...new Set([...explicitSkills, ...(trust.trusted && resolved.skillDiscovery !== false ? [join(trust.projectRoot, ".agentrig", "skills")] : [])])].length,
    extension: (Array.isArray(resolved.extension) ? resolved.extension as string[] : []).map(path => resolve(cwd, path)),
    extensionCwd: cwd,
    ...(trust.trusted ? { trustedProjectRoot: trust.projectRoot } : {}),
    modelExplicit: cli.model !== undefined || environment.AGENTRIG_MODEL !== undefined || configHas("model"),
    maxTokensPerTurnExplicit: cli.maxTokensPerTurn !== undefined || configHas("maxTokensPerTurn"),
    // R3.5a: typed provider flags (or AGENTRIG_MODEL) pin the MAIN role to the flat default entry;
    // a `model` that came from config does not, or `roles.main` could never win over a profile's model
    providerOverride:
      cli.provider !== undefined || cli.model !== undefined || cli.baseUrl !== undefined || environment.AGENTRIG_MODEL !== undefined,
  };
}
