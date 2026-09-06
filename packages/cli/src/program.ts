import { Command, InvalidArgumentError } from "commander";
import { createInterface } from "node:readline/promises";
import { CommandPrefixSchema, SessionStore, sanitizeLine } from "@agentkitai/agentrig-core";
import { DreamLimitsSchema, IngestLimitsSchema, ScanLimitsSchema } from "@agentkitai/agentrig-memory";
import { renderEvent } from "./render.js";
import { forkSession, replaySession, searchSessions, showSessionEvidence } from "./sessions.js";
import { exportSession } from "./session-export.js";
import { evaluateSessions, type SessionEvaluationDependencies } from "./session-evaluation.js";
import { reviewChanges, renderReview, reviewFailure, type ReviewOptions, type ReviewDependencies } from "./review.js";
import { runCi, type CiDependencies, type CiFlags } from "./ci-run.js";
import { formatAuxiliaryUsage } from "@agentkitai/agentrig-memory";
import { undoSession } from "@agentkitai/agentrig-core";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_SESSIONS_DIR, RUN_NUMERIC_DEFAULTS, runCommand, type RunOptions, type RunSummary } from "./run.js";
import { loginCommand } from "./login.js";
import { mcpLoginCommand, type McpLoginOptions } from "./mcp-login.js";
import { dreamCommand, type DreamOptions } from "./dream.js";
import { startTui } from "./tui/start.js";
import { startAcp, type AcpDependencies, type AcpFlags } from "./acp.js";
import { startWeb, type WebDependencies, type WebFlags } from "./web.js";
import { startMcpServe, type McpServeDependencies } from "./mcp-serve.js";
import { loadRunConfig, type LoadRunConfigOptions } from "./config.js";
import { addPackage } from "./packages.js";
import { withMaintenanceSignal } from "./maintenance.js";
import { resolveProjectBoundary, resolveProjectTrust } from "./trust.js";
import { ScheduleStore } from "./schedule.js";
import { ScheduleReports } from "./schedule-report.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function parseIngestLimits(text: string) {
  try { return IngestLimitsSchema.parse(JSON.parse(text)); }
  catch (error) { throw new InvalidArgumentError(`invalid ingest limits: ${String(error)}`); }
}

function collectCommandPrefix(text: string, previous: string[][]): string[][] {
  if (Buffer.byteLength(text) > 16_384 || previous.length >= 128) throw new InvalidArgumentError("command prefixes are limited to 128 entries of at most 16 KiB");
  try { return [...previous, CommandPrefixSchema.parse(JSON.parse(text))]; }
  catch (error) { throw new InvalidArgumentError(`invalid command argv prefix: ${String(error)}`); }
}

function parseDreamScanLimits(text: string) {
  try { return ScanLimitsSchema.partial().parse(JSON.parse(text)); }
  catch (error) { throw new InvalidArgumentError(`invalid dream scan limits: ${String(error)}`); }
}

function parseDreamLimits(text: string) {
  try { return DreamLimitsSchema.parse(JSON.parse(text)); }
  catch (error) { throw new InvalidArgumentError(`invalid dream limits: ${String(error)}`); }
}

function ingestSpanChars(value: string): string {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 2_147_483_647) throw new InvalidArgumentError("ingest span characters must be an integer from 2 to 2147483647");
  return value;
}
import { diagnose, type DoctorCliValues, type DoctorOptions } from "./doctor.js";
import {
  memoryIngest,
  memoryInit,
  memoryLint,
  memoryLs,
  memoryPromote,
  memoryResetDreamStamp,
  memoryDiscardDream,
  memorySearch,
  memoryShow,
  type MemoryIngestOptions,
  type MemoryPromoteOptions,
} from "./memory.js";

/**
 * Builds the command tree without parsing, so a test can drive argv fixtures against it.
 *
 * Extracted after a root-level option regression shipped: options added to the root `program` are
 * consumed by Commander wherever they appear in argv, including after a subcommand name, so every
 * subcommand silently lost `--root`, `--model`, `--max-turns` and the rest. Nothing could catch
 * that, because nothing could parse argv without also running the CLI.
 */
/**
 * The default command catches ANY unmatched argv, so a typo'd subcommand would drop the user
 * into an interactive agent with their intended command silently discarded. Returns the error to
 * report, or null when the operands are genuinely empty (a real bare `agentrig`).
 *
 * Pure so it can be tested directly: an integration test cannot reach it, because stubbing the
 * command tree's actions is the only way to parse argv without launching the CLI.
 */
export function describeStray(args: string[], known: string[]): string | null {
  const stray = args.filter((a) => !a.startsWith("-"));
  if (stray.length === 0) return null;
  const guess = closest(stray[0]!, known);
  return `error: unknown command '${stray[0]!}'${guess === null ? "" : `\n(Did you mean ${guess}?)`}`;
}

/** One-edit-distance-ish suggestion, so a typo gets the same help Commander used to give. */
function closest(input: string, known: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const d = distance(input, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

function sequence(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError("expected a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("expected a non-negative safe integer");
  return parsed;
}

export interface ProgramDependencies {
  scheduleNow?: () => Date;
  run?: typeof runCommand;
  tui?: typeof startTui;
  config?: LoadRunConfigOptions;
  doctor?: DoctorOptions;
  evaluation?: SessionEvaluationDependencies;
  mcpLogin?: typeof mcpLoginCommand;
  review?: ReviewDependencies;
  ci?: CiDependencies;
  acp?: AcpDependencies;
  web?: WebDependencies;
  mcpServe?: McpServeDependencies;
}

export function buildProgram(dependencies: ProgramDependencies = {}): Command {
  const executeRun = dependencies.run ?? runCommand;
  const executeTui = dependencies.tui ?? startTui;
  const program = new Command();
  program.name("agentrig").description("AgentRig — agentic harness with a built-in supervisor loop and LLM Wiki memory");
  /**
   * `--profile` is ALSO registered on the root, so it can precede a subcommand — the shape an
   * alias produces (`alias rigp='agentrig --profile personal'` broke every subcommand with
   * "unknown command 'sessions' (Did you mean sessions?)").
   *
   * This is the pattern that once caused the root-option regression documented above, contained
   * two ways: only this one option is dual-registered (Commander scans root options out of argv
   * wherever they appear, so a root option swallows the SAME flag from subcommands — every other
   * flag still parses on its subcommand exactly as before), and the value is recovered where
   * config is resolved via `optsWithGlobals()`, which `program.test.ts` and `config.test.ts` pin
   * in both positions. On subcommands that never consult config (`sessions ls`, `login`, …) a
   * --profile in ANY position is accepted, and the preAction hook below says it is ignored —
   * erroring instead would break the very alias shape this exists for, since a wrapper appends
   * the flag to every subcommand it forwards.
   *
   * Known, accepted cost (adversarial review, PR #57): the root scan also consumes a literal
   * "--profile" appearing as another option's VALUE (`--system "--profile"`), erroring about a
   * flag the user never set. The escape hatches work: `--system=--profile` and anything after
   * `--` are never scanned. `enablePositionalOptions()` would remove the whole class but forbids
   * the pinned bare-launch shape `agentrig --yolo`, so it is not worth that trade.
   */
  program.option("--profile <name>", "named config profile to overlay (may precede the subcommand)");
  /** The entry points whose actions resolve config and therefore honour --profile. */
  const PROFILE_AWARE = new Set(["run", "tui", "doctor", "resume", "tick", "eval", "review", "acp", "web", "mcp-serve"]);
  program.hook("preAction", (_thisCommand, actionCommand) => {
    // A profile aimed at a command that never consults config is accepted so aliases keep
    // working, but never silently: an ignored flag the user typed deserves a note (the same
    // contract bash's background timeoutMs settled on).
    const profile = (actionCommand.optsWithGlobals() as { profile?: string }).profile;
    if (profile !== undefined && !PROFILE_AWARE.has(actionCommand.name()) && !(actionCommand.name() === "login" && actionCommand.parent?.name() === "mcp")) {
      console.error(`note: --profile is ignored by \`${actionCommand.name()}\` — it does not read config profiles`);
    }
  });

  function withProviderOptions(cmd: Command): Command {
    return cmd
      .option(
        "-p, --provider <provider>",
        "model provider: anthropic | openai (OpenAI-compatible) | openai-chatgpt (experimental subscription auth)",
        "anthropic",
      )
      .option("-m, --model <model>", "model id", process.env.AGENTRIG_MODEL ?? DEFAULT_ANTHROPIC_MODEL)
      .option(
        "--base-url <url>",
        "server base URL override (OpenAI-compatible servers; also honoured by anthropic and openai-chatgpt entries)",
      );
  }

  const INTERACTIVE_MAX_TURNS = "50";
  const HEADLESS_MAX_TURNS = "300";

  function withRunOptions(cmd: Command, maxTurnsDefault: string): Command {
    return withProviderOptions(cmd)
      .option("--profile <name>", "named config profile to overlay")
      .option("--trust", "load project instructions and config for this run only")
      .option("--headless", "never prompt; `ask` permissions resolve to deny (also implied when stdin is not a TTY)")
      .option("--json", "emit raw event JSONL to stdout")
      .option("--verbose", "show the raw event trace instead of just the conversation")
      .option("--memory <dir>", "inject this memory wiki's index into the system prompt", ".agentrig")
      .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
      .option("--system <prompt>", "override the system prompt")
      .option(
        "--allow <rule>",
        "allow a tool name or permission class, confined to the cwd for paths; append :anywhere to lift (repeatable)",
        collect,
        [],
      )
      .option("--drift-scope <path>", "path the drift detector may change (repeatable)", collect, [])
      .option("--allow-command <argv-json>", "allow a literal foreground shell argv prefix, e.g. '[\"git\",\"status\"]' (repeatable; not a read-only guarantee)", collectCommandPrefix, [])
      .option(
        "--drift-contract <path>",
        "build or test contract path the drift detector watches (repeatable)",
        collect,
        undefined,
      )
      .option("--deny <rule>", "deny a tool name or permission class (repeatable)", collect, [])
      .option(
        "--dangerously-skip-permissions",
        "allow every tool call without asking, including outside the working directory; --deny still applies",
      )
      .option("--yolo", "alias for --dangerously-skip-permissions")
      .option("--sandbox-network", "allow network inside an enforcing sandbox; does not grant tool permission")
      .option("--otel-endpoint <url>", "explicit OTLP/HTTP JSON traces URL; exports minimized timing/status metadata")
      .option("--checkpoints", "opt-in checkpoints for undo; requires --sandbox none and stopped external/background writers")
      .option(
        "--sandbox <mode>",
        "execution boundary: read-only, workspace-write, or none; enforcing modes refuse host hooks and MCP startup",
        "none",
      )
      .option("--max-turns <n>", "turn budget", maxTurnsDefault)
      .option("--max-tokens <n>", "token budget (input + cache read/write + output)")
      .option("--max-minutes <n>", "wall-clock budget in minutes")
      .option("--max-usd <n>", "USD budget; requires --price-in/--price-out")
      .option("--price-in <usd>", "uncached input price in USD per million tokens")
      .option("--price-out <usd>", "output price in USD per million tokens")
      .option("--price-cache-read <usd>", "cache-read price per million tokens; overrides provider default")
      .option("--price-cache-write <usd>", "cache-write price per million tokens; overrides provider default")
      .option("--max-tokens-per-turn <n>", "max_tokens per model response", RUN_NUMERIC_DEFAULTS.maxTokensPerTurn)
      .option("--supervise", "attach the supervisor: heuristic detectors + escalating policy ladder")
      .option("--supervisor-abort", "allow the supervisor's final ladder rung to abort the session")
      .option("--supervisor-abort-restores", "restore an owned checkpoint after supervisor abort; requires --supervise --supervisor-abort --checkpoints and stopped external writers")
      .option("--supervisor-no-abort", "compatibility no-op: abort is disabled unless --supervisor-abort is set")
      .option("--supervisor-soft <fraction>", "fraction of the budget at which the soft warning trips", RUN_NUMERIC_DEFAULTS.supervisorSoft)
      .option(
        "--supervisor-turns-remaining <n>",
        "warn when this many turns remain, even if the soft fraction has not tripped",
        RUN_NUMERIC_DEFAULTS.supervisorTurnsRemaining,
      )
      .option(
        "--supervisor-review",
        "enable the LLM-backed supervisor rungs (trajectory reviewer + rubric grader); costs tokens",
      )
      .option("--ingest-on-end", "distil this session into the wiki when it finishes (PLAN §3.2); costs tokens")
      .option("--dream-on-end", "run the scheduled dream when one is due (PLAN §3.7); reports, never applies")
      .option("--dream-every-sessions <n>", "sessions since the last dream before one is due", RUN_NUMERIC_DEFAULTS.dreamEverySessions)
      .option("--dream-every-hours <n>", "hours since the last dream before one is due", RUN_NUMERIC_DEFAULTS.dreamEveryHours)
      .option("--dream-structural-only", "the scheduled dream skips the model-backed pass — free, no tokens")
      .option("--dream-scan-limits <json>", "wiki/raw scan limits (JSON object; includes scheduler enumeration)", parseDreamScanLimits)
      .option("--dream-limits <json>", "dream lifetime/model limits (JSON object)", parseDreamLimits)
      .option("--mcp-config <path>", "JSON file of MCP servers whose tools are added to this session")
      .option("--subagents", "give the agent a `subagent` tool for context-isolated sub-tasks")
      .option("--subagent-max-turns <n>", "turn budget for each subagent", "15")
      .option("--subagent-max-children <n>", "subagents one session may run in total", "8")
      .option("--skills <dir>", "directory of markdown skills; earlier dirs shadow later (repeatable)", collect, [])
      .option("--extension <path>", "trust and activate a host-code .mjs extension with required sidecar (repeatable; sandbox none only)", collect, [])
      .option("--no-extension-discovery", "do not activate trusted-project .agentrig/extensions host code")
      .option("--no-packages", "do not discover installed trusted-project skill/extension packages")
      .option(
        "--skill-discovery",
        "override config and auto-load .agentrig/skills from the trusted project root and home",
      )
      .option("--no-skill-discovery", "do not auto-load ordinary or generated skill directories")
      .option("--generated-skills", "opt in to generated skills from selected project memory and safe home; provenance is not approval")
      .option("--no-generated-skills", "override config and omit automatic generated-skill roots (explicit --skills directories remain)")
      // Config may enable a boolean; paired negations let one invocation still override it.
      .option("--no-dangerously-skip-permissions", "override config and require permission checks")
      .option("--no-yolo", "override config and require permission checks")
      .option("--no-supervise", "override config and disable supervision")
      .option("--no-supervisor-abort", "override config and disable supervisor aborts")
      .option("--no-supervisor-review", "override config and disable trajectory review")
      .option("--no-ingest-on-end", "override config and skip session-end memory ingest")
      .option("--ingest-limits <json>", "bounded ingest limits (JSON object; e.g. maxSpans, maxCalls, timeoutMs)", parseIngestLimits)
      .option("--ingest-span-chars <n>", "maximum characters per ingest span (default 6000)", ingestSpanChars)
      .option("--no-dream-on-end", "override config and skip scheduled session-end dream")
      .option("--no-dream-structural-only", "override config and allow model-backed dream consolidation")
      .option("--no-subagents", "override config and disable subagents")
      .option("--repo-map", "override config and inject the mechanical repository structure map")
      .option("--no-repo-map", "do not inject the mechanical repository structure map")
      .option(
        "--shell <path>",
        "shell for the `bash` tool (default: /bin/sh; on Windows, Git Bash then PowerShell then cmd)",
      );
  }

  // AGENTRIG_MODEL baked into the flag default still counts as an explicit model choice
  function modelExplicit(cmd: Command): boolean {
    return cmd.getOptionValueSource("model") !== "default" || process.env.AGENTRIG_MODEL !== undefined;
  }

  async function confirmTrust(message: string): Promise<boolean> {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(?:es)?$/i.test((await prompt.question(message)).trim());
    } finally {
      prompt.close();
    }
  }

  async function configured<T extends { profile?: string }>(opts: T, cmd: Command, interactive: boolean): Promise<T | undefined> {
    // The root-level --profile is scanned out of argv wherever it appears, so the subcommand's
    // own opts may not carry it even when the user typed it after the subcommand; optsWithGlobals
    // recovers the value (the subcommand's own, were it ever set, wins).
    const globalProfile = (cmd.optsWithGlobals() as { profile?: string }).profile;
    if (opts.profile === undefined && globalProfile !== undefined) opts = { ...opts, profile: globalProfile };
    try {
      return (await loadRunConfig(cmd, opts as unknown as Record<string, unknown>, {
        ...dependencies.config,
        interactive,
        confirmTrust: dependencies.config?.confirmTrust ?? confirmTrust,
      })) as unknown as T;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return undefined;
    }
  }

  withRunOptions(
    program.command("run [task]").description("Run the agent on a task, non-interactively"),
    HEADLESS_MAX_TURNS,
  )
    .option("--resume <id>", "continue an existing session from its snapshot")
    .option("--ci", "bounded CI mode: explicit file input, headless asks fail closed, never YOLO")
    .option("--task-file <path>", "CI task text, at most 16 KiB")
    .option("--event-file <path>", "CI JSON event, at most 256 KiB; no implicit environment lookup")
    .option("--event-field <selector>", "CI selector: issue.body, comment.body or pull_request.body")
    .option("--report <path>", "create-only CI Markdown report under an existing parent")
    .option("--pr <number>", "explicit CI comment target; requires --repo and --comment")
    .option("--repo <owner/repo>", "literal CI GitHub repository, never inferred from payload")
    .option("--comment", "explicit CI PR comment; needs exec+net, matching identity and complete accounting")
    .addHelpText("after", "\nCI requires exactly one task/event file and an explicit report path and/or complete PR comment target. CI ceilings: 20 turns, 5 minutes, 50000 main tokens; smaller configured limits win. Auxiliary/child/remote usage is not a hard total billing cap. Effective YOLO, resume and positional CI tasks refuse. Reports redact heuristically, not perfectly; unknown secrets may remain.\n")
    .option("--answer-policy <policy>", "required questions: fail (default), first-option, or file:<path>; automated answers are not human approval")
    .action(async (task: string | undefined, opts: RunOptions & CiFlags, cmd: Command) => {
      const flags: CiFlags = { ci: opts.ci, taskFile: opts.taskFile, eventFile: opts.eventFile, eventField: opts.eventField,
        report: opts.report, pr: opts.pr, repo: opts.repo, comment: opts.comment };
      if (opts.ci === true ? task !== undefined : task === undefined || Object.entries(flags).some(([key, value]) => key !== "ci" && value !== undefined)) {
        console.error("run requires a positional task, or --ci with explicit file input/output flags; do not mix the two modes"); process.exitCode = 1; return;
      }
      // `run` is a headless entry point even when launched from a terminal.
      const resolved = await configured(opts, cmd, false);
      if (resolved === undefined) return;
      if (opts.ci === true) {
        try { await withMaintenanceSignal(signal => runCi(flags, resolved, signal, { run: executeRun, ...dependencies.ci }), undefined, "CI run"); }
        catch { console.error("CI run refused or failed; no validated completion report"); process.exitCode = 1; }
      } else await executeRun(task!, resolved);
    });

  withProviderOptions(program.command("review").description("One bounded advisory diff review; costs supervisor-role tokens, never runs tests"))
    .option("--profile <name>", "named config profile")
    .option("--trust", "load trusted project config")
    .option("--base <ref>", "review resolved commit-to-HEAD changes (default: tracked HEAD-to-worktree)")
    .option("--pr <number>", "read a GitHub PR using gh; requires exec and net authorization")
    .option("--comment", "explicitly post one advisory comment to --pr after identity/usage checks")
    .option("--allow <rule>", "allow a permission class/tool; PR reads and comments need exec and net", collect, [])
    .option("--deny <rule>", "deny a permission class/tool", collect, [])
    .option("--yolo", "allow otherwise unconfigured decisions; explicit deny and sandbox refusal still win")
    .option("--sandbox <mode>", "host git/gh currently requires none", "none")
    .option("--max-tokens-per-turn <n>", "requested response-token ceiling, at most 2048", "2048")
    .option("--max-minutes <n>", "operation wall-clock ceiling, at most 1.5", "1.5")
    .addHelpText("after", "\nLocal review requires the repository root. Tracked text only: untracked, binary, submodule and metadata-only changes are not reviewed. Refuses diffs over 16 KiB, 40 files or 128 hunks rather than silently trimming. Configured Git filters and total-session token/USD caps refuse; choose supported time/per-response limits in a review profile. Headless ask denies. No tools/tests/edits, automatic posting or correctness guarantee.\nExamples: agentrig review; agentrig review --base main; agentrig review --pr 12 --allow exec --allow net [--comment]\n")
    .action(async (opts: ReviewOptions, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved === undefined) return;
      try {
        const result = await withMaintenanceSignal(signal => reviewChanges(process.cwd(), resolved, signal, {
          ...dependencies.review,
          onUsage: report => { console.error(formatAuxiliaryUsage(report)); dependencies.review?.onUsage?.(report); },
        }), undefined, "diff review");
        console.log(renderReview(result).join("\n"));
      } catch (error) { console.error(reviewFailure(error)); process.exitCode = 1; }
    });

  withRunOptions(program.command("acp").description("Serve stable Agent Client Protocol v1 over stdio"), HEADLESS_MAX_TURNS)
    .action(async (flags: AcpFlags, cmd: Command) => {
      const profile = (cmd.optsWithGlobals() as { profile?: string }).profile;
      await startAcp(cmd, { ...flags, ...(profile === undefined ? {} : { profile }) }, {
        ...(dependencies.config === undefined ? {} : { config: dependencies.config }), ...dependencies.acp,
      });
    });

  withRunOptions(program.command("web").description("Serve the authenticated loopback ACP reference page"), HEADLESS_MAX_TURNS)
    .option("--host <host>", "only the literal 127.0.0.1 is accepted", "127.0.0.1")
    .option("--port <port>", "local TCP port; zero selects an ephemeral port", "0")
    .action(async (flags: WebFlags, cmd: Command) => {
      const profile = (cmd.optsWithGlobals() as { profile?: string }).profile;
      await startWeb(cmd, { ...flags, ...(profile === undefined ? {} : { profile }) }, {
        ...(dependencies.config === undefined ? {} : { config: dependencies.config }), ...dependencies.web,
      });
    });

  withRunOptions(program.command("mcp-serve").description("Serve four bounded MCP tools over stdio under configured permissions"), "20")
    .action(async (flags: AcpFlags, cmd: Command) => {
      const profile = (cmd.optsWithGlobals() as { profile?: string }).profile;
      await startMcpServe(cmd, { ...flags, ...(profile === undefined ? {} : { profile }) }, {
        ...(dependencies.config === undefined ? {} : { config: dependencies.config }), ...dependencies.mcpServe,
      });
    });

  const schedule = program.command("schedule").description("Manage literal UTC tasks; tick previews unless --execute is explicit");
  async function scheduleStore(): Promise<ScheduleStore> {
    const boundary = await resolveProjectBoundary(dependencies.config?.cwd ?? process.cwd(), dependencies.config?.home ?? homedir());
    return new ScheduleStore(boundary.projectRoot);
  }
  schedule.command("ls").action(async () => console.log(JSON.stringify(await (await scheduleStore()).read(), null, 2)));
  schedule.command("add <id> <cron> <task>")
    .option("--max-turns <n>", "turn budget 1–50", "5")
    .option("--max-tokens <n>", "requested token budget 1–100000", "10000")
    .option("--max-minutes <n>", "runtime minute budget 1–30", "5")
    .action(async (id: string, cron: string, task: string, flags: { maxTurns: string; maxTokens: string; maxMinutes: string }) => {
      await (await scheduleStore()).add({ id, cron, task, flags: { maxTurns: Number(flags.maxTurns), maxTokens: Number(flags.maxTokens), maxMinutes: Number(flags.maxMinutes) } });
      console.log(`added schedule ${id}`);
    });
  schedule.command("rm <id>").action(async (id: string) => { await (await scheduleStore()).remove(id); console.log(`removed schedule ${id}`); });
  withProviderOptions(schedule.command("tick"))
    .option("--execute", "explicitly execute due tasks; default is model-free preview")
    .option("--trust", "trust canonical project for this tick only")
    .option("--json", "render executed session events as JSONL")
    .action(async (opts: { execute?: boolean; trust?: boolean; json?: boolean; profile?: string }, cmd: Command) => {
      const store = await scheduleStore();
      const date = (dependencies.scheduleNow ?? (() => new Date()))();
      if (opts.execute !== true) { console.log(JSON.stringify({ preview: true, due: await store.tick(date, undefined, undefined, 5) })); return; }
      const trust = await resolveProjectTrust(store.projectRoot, { home: dependencies.config?.home ?? homedir(), interactive: false, ...(opts.trust === undefined ? {} : { explicitTrust: opts.trust }) });
      if (!trust.trusted) throw new Error("scheduled execution requires trusted canonical project; use --trust explicitly");
      // These are shared defaults, not typed CLI overrides: preserve config precedence.
      for (const [key, value] of Object.entries(RUN_NUMERIC_DEFAULTS)) cmd.setOptionValueWithSource(key, value, "default");
      const resolved = await configured({ ...RUN_NUMERIC_DEFAULTS, ...opts }, cmd, false);
      if (resolved === undefined) return;
      const runOptions = resolved as unknown as RunOptions;
      const reports = new ScheduleReports(store.projectRoot);
      await withMaintenanceSignal(async signal => {
        let failed = false;
        await store.tick(date, async (entry, minute) => {
          signal.throwIfAborted();
          process.exitCode = 0;
          let result: RunSummary | void = undefined;
          let outcome: RunSummary["reason"] = "error";
          let launchError: unknown;
          try {
            result = await executeRun(entry.task, {
              ...resolved, root: join(store.projectRoot, ".agentrig", "raw", "sessions"),
              maxTurns: String(entry.flags.maxTurns), maxTokens: String(entry.flags.maxTokens),
              maxMinutes: String(entry.flags.maxMinutes),
              ...(entry.heartbeat === undefined && runOptions.memory !== undefined
                ? { ingestOnEnd: runOptions.ingestOnEndExplicit === true ? runOptions.ingestOnEnd !== false : true } : {}),
              ...(entry.heartbeat === undefined ? {} : { heartbeat: entry.heartbeat }),
              headless: true, scheduled: { entryId: entry.id, minute, ...(entry.heartbeat === undefined ? {} : { source: "heartbeat" as const }) }, signal,
            } as RunOptions);
            outcome = result?.reason ?? (Number(process.exitCode) === 0 ? "done" : "error");
          } catch (error) {
            launchError = error;
            outcome = signal.aborted ? "aborted" : "error";
          }
          const maintenanceFailed = result?.maintenanceFailed === true;
          failed ||= outcome !== "done" || maintenanceFailed;
          if (entry.heartbeat === undefined || outcome !== "done" || maintenanceFailed) {
            console.error(JSON.stringify({ schedule: entry.id, source: entry.heartbeat === undefined ? "schedule" : "heartbeat", minute, outcome,
              ...(result === undefined ? { claimRetained: true } : { sessionId: result.id }), ...(maintenanceFailed ? { maintenanceFailed } : {}) }));
            try {
              await reports.append({ ts: Date.now(), minute, entry: entry.id, source: entry.heartbeat === undefined ? "schedule" : "heartbeat",
                sessionId: result?.id ?? null, outcome, maintenanceFailed, accounting: result?.scheduledAccounting ?? null });
            } catch (error) {
              failed = true;
              console.error(`scheduled outcome receipt unavailable; claim retained, failure history may be incomplete; do not retry execution: ${error instanceof Error ? error.message : String(error)}`);
              try { await reports.markUncertain(); }
              catch { console.error("scheduled uncertainty marker could not be persisted; stderr/exit status are the only failure record; inspect raw logs, do not retry execution"); }
            }
          }
          if (signal.aborted && launchError !== undefined) throw launchError;
          signal.throwIfAborted();
        }, signal, Number((resolved as { heartbeatMaxTurns?: string }).heartbeatMaxTurns ?? "5"));
        process.exitCode = failed ? 1 : 0;
      }, undefined, "schedule tick");
    });

  function collect(value: string, prev: string[] = []): string[] {
    return [...prev, value];
  }

  program
    .command("login <provider>")
    .description("Sign in to a subscription provider (experimental: openai-chatgpt browser OAuth)")
    .option("--export", "print the stored token bundle (to seed AGENTRIG_OPENAI_CHATGPT_TOKEN) instead of signing in")
    .option("--no-browser", "print the sign-in URL and wait, without opening a browser")
    .action(async (provider: string, opts: { export?: boolean; browser?: boolean }) =>
      // commander turns `--no-browser` into `browser: false`
      loginCommand(provider, { ...opts, ...(opts.browser === false ? { noBrowser: true } : {}) }),
    );

  program.command("mcp").description("Manage remote MCP credentials")
    .command("login <server>").description("Explicit OAuth login; print the validated browser URL, never invoke a model")
    .requiredOption("--mcp-config <path>", "JSON configuration containing the remote OAuth server")
    .option("--trust", "load project configuration for this invocation only")
    .option("--profile <name>", "named configuration profile")
    .option("--allow <rule>", "network policy allow rule (repeatable)", collect, [])
    .option("--deny <rule>", "network policy deny rule (repeatable)", collect, [])
    .option("--headless", "do not prompt for network consent")
    .option("--sandbox <mode>", "sandbox policy; HTTP runs in the trusted host", "none")
    .option("--sandbox-network", "explicitly permit trusted host networking under sandbox policy")
    .action(async (server: string, opts: McpLoginOptions & { profile?: string }, cmd: Command) => {
      const resolved = await configured(opts, cmd, !opts.headless && !!process.stdin.isTTY);
      if (!resolved) return;
      await withMaintenanceSignal(signal => (dependencies.mcpLogin ?? mcpLoginCommand)(server, resolved, signal), undefined, "MCP login");
    });

  const memory = program.command("memory").description("Inspect and maintain the LLM Wiki memory");
  const memoryDir = (cmd: Command): Command =>
    cmd.option("-d, --dir <dir>", "memory directory", ".agentrig");

  memory.command("discard-dream <outputRoot>").description("Preview one owned dream artifact; discard only a released or stopped producer's copy")
    .option("--owner <uuid>", "exact owner UUID observed in preview")
    .option("--confirm", "discard this output/sidecar; never reclaim writer locks or source/install backups")
    .action(async (outputRoot: string, opts: { owner?: string; confirm?: boolean }) => memoryDiscardDream(outputRoot, opts));

  memoryDir(memory.command("init").description("Create the .agentrig raw/ + wiki/ layout and SCHEMA.md")).action(
    async (opts: { dir: string }) => memoryInit(opts),
  );
  memoryDir(memory.command("ls").description("List every wiki page from index.md")).action(
    async (opts: { dir: string }) => memoryLs(opts),
  );
  memoryDir(memory.command("show <path>").description("Print one wiki page")).action(
    async (path: string, opts: { dir: string }) => memoryShow(path, opts),
  );
  memoryDir(memory.command("search <query...>").description("Index ∪ BM25 search over the wiki"))
    .option("-k, --k <n>", "max results", "8")
    .action(async (query: string[], opts: { dir: string; k?: string }) => memorySearch(query.join(" "), opts));
  withProviderOptions(memoryDir(memory.command("promote <path>").description("Preview evidence offline; --confirm also requires a bounded memory-role effect assessment")))
    .option("--confirm", "request publication after evidence review and model effect assessment; no guard bypass")
    .option("--guardrail-limits <json>", "promotion effect-assessment lifetime/model limits (JSON object)", parseDreamLimits)
    .action(async (path: string, opts: MemoryPromoteOptions, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await memoryPromote(path, { ...resolved, modelExplicit: modelExplicit(cmd) || resolved.modelExplicit === true });
    });
  memoryDir(memory.command("lint").description("Dry-run dream report — structural only, no model call, no output store"))
    .option("--dream-scan-limits <json>", "wiki/raw scan limits (JSON object)", parseDreamScanLimits)
    .option("--dream-limits <json>", "dream lifetime/model limits (JSON object)", parseDreamLimits)
    .action(async (opts: { dir: string; profile?: string }, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await memoryLint(resolved);
    });
  memoryDir(memory.command("reset-dream-stamp").description("Reset scheduling metadata into a preserved backup; stop running/scheduled dreams first"))
    .option("--confirm", "archive the regular .last-dream file and reset scheduling; never removes writer locks")
    .action(async (opts: { dir: string; confirm?: boolean }) => memoryResetDreamStamp(opts));
  withProviderOptions(
    memoryDir(memory.command("ingest <sessionId>").description("Distill a session log into the wiki")),
  ).option("--ingest-limits <json>", "bounded ingest limits (JSON object)", parseIngestLimits)
    .option("--ingest-span-chars <n>", "maximum characters per ingest span (default 6000)", ingestSpanChars)
    .action(async (sessionId: string, opts: MemoryIngestOptions, cmd: Command) => {
    // R3.5a: ingest is the memory role; without config it stays exactly the flags it was given
    const resolved = await configured(opts, cmd, false);
    if (resolved !== undefined) await memoryIngest(sessionId, { ...resolved, modelExplicit: modelExplicit(cmd) || resolved.modelExplicit === true });
  });

  // PLAN §5: agentrig dream [--review|--auto] [--scope project|global] [--since <n>]
  withProviderOptions(
    program
      .command("dream")
      .description("Scheduled lint: writes a NEW wiki plus a change report; your wiki is untouched unless --auto"),
  )
    .option("-d, --dir <dir>", "memory directory", ".agentrig")
    .option("--review", "report only, leave the dreamt wiki on disk for inspection (default)")
    .option("--auto", "apply the dreamt wiki, keeping the previous one beside it")
    .option("--scope <scope>", "project | global", "project")
    .option("--global <dir>", "global memory directory; enables promotion proposals")
    .option("--since <n>", "cap on raw sessions scanned")
    .option("--dream-scan-limits <json>", "wiki/raw scan limits (JSON object)", parseDreamScanLimits)
    .option("--lock-timeout <ms>", "wait for memory mutation locks (default 5000 ms); not a scan deadline")
    .option("--dream-limits <json>", "dream lifetime/model limits (JSON object)", parseDreamLimits)
    .option("--structural-only", "skip the model-backed consolidation pass — free, no credential needed")
    .option("--skill-candidates", "report evidence-backed procedures; model refinement/effect checks share --dream-limits (no skill files emitted)")
    .option("--emit-skills", "preview exact generated SKILL.md files; opt-in only, never activates skills")
    .option("--apply <review-digest>", "with --emit-skills, confirm the exact preview digest; fresh evidence/effect checks required, never applies wiki changes")
    .action(async (opts: DreamOptions, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await dreamCommand({ ...resolved, modelExplicit: modelExplicit(cmd) || resolved.modelExplicit === true });
    });

  program.command("package").description("Local create-only bundles; no scripts or registry fetching")
    .command("add <source>").description("Validate and install a local directory or npm tarball; existing destinations refuse")
    .option("--trust", "explicitly trust this project for installed extension code and instructions")
    .action(async (source: string, opts: { trust?: boolean }) => {
      const cwd = dependencies.config?.cwd ?? process.cwd();
      const trust = await resolveProjectTrust(cwd, { home: dependencies.config?.home ?? homedir(), interactive: false,
        explicitTrust: opts.trust === true });
      if (!trust.trusted) throw new Error("package installation requires a trusted project; review its code and use --trust explicitly");
      const result = await withMaintenanceSignal(signal => addPackage({ projectRoot: trust.projectRoot, source: resolve(cwd, source), signal }), undefined, "package installation");
      console.log(`installed ${result.name}@${sanitizeLine(result.version, 128)}\n${sanitizeLine(result.destination, 4096)}\nintegrity ${result.digest} (change detection, not authenticity)`);
      if (result.prompts.length > 0) console.log(`prompt files stored inertly: ${result.prompts.join(", ")}`);
      if (result.ignored.length > 0) console.log(`ignored: ${result.ignored.join(", ")}`);
    });

  program
    .command("doctor")
    .description("Diagnose local configuration read-only; --probe explicitly runs potentially billable provider samples")
    .option("--probe", "run bounded potentially billable provider conformance samples and cache local observations")
    .option("-p, --provider <provider>", "provider override to diagnose")
    .option("-m, --model <model>", "model override to diagnose")
    .option("--base-url <url>", "server base URL override to diagnose (OpenAI-compatible servers; also honoured by anthropic and openai-chatgpt entries)")
    .option("--profile <name>", "named config profile to diagnose")
    .option("--memory <dir>", "memory directory override")
    .option("--mcp-config <path>", "MCP config override")
    .action(async (opts: DoctorCliValues, cmd: Command) => {
      // same recovery as `configured`: a root-level --profile is invisible in this command's opts
      const globalProfile = (cmd.optsWithGlobals() as { profile?: string }).profile;
      if (opts.profile === undefined && globalProfile !== undefined) opts = { ...opts, profile: globalProfile };
      const result = await diagnose({ ...dependencies.doctor, cli: opts });
      for (const diagnostic of result.lines) console.log(diagnostic);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });

  program.command("eval <sessions...>")
    .description("Preview explicit session→E1 fixture evaluation against a supported profile; no historic tool replay")
    .requiredOption("--against <profile>", "named supported evaluation profile")
    .requiredOption("--fixtures <file>", "bounded version-1 session/task/source/baseline map and local image IDs")
    .requiredOption("--output <new-directory>", "exclusive retained evaluation evidence directory (created only with --execute)")
    .option("--execute", "run isolated tasks and advisory grading; may spend provider tokens")
    .option("--trust", "explicitly trust project configuration for this invocation")
    .option("--batch-tokens <n>", "required reported-token scheduling cap for execution, not a hard billing cap")
    .option("--batch-minutes <n>", "required total execution wall-time limit")
    .addHelpText("after", "\nPreview makes no provider calls. Execution requires Linux Docker and pre-existing image IDs; never pulls images or installs dependencies. Shipped worker supports X tasks; A tasks require a matching offline dependency image. Independent checks decide outcomes; M6 grades are advisory. See docs/plans/R9b.md.\nExample: agentrig eval SESSION --against candidate --fixtures fixtures.json --output ./new-evaluation\nAdd --execute --batch-tokens 100000 --batch-minutes 10 only after reviewing the preview.")
    .action(async (ids: string[], _opts: unknown, cmd: Command) => {
      try {
      const opts = cmd.optsWithGlobals() as { against: string; fixtures: string; output: string; execute?: boolean;
        batchTokens?: string; batchMinutes?: string; profile?: string; trust?: boolean };
      if (opts.profile !== undefined && opts.profile !== opts.against) throw new Error("--profile and --against must select the same evaluation profile");
      const defaults = {
        provider: "anthropic" as const, model: DEFAULT_ANTHROPIC_MODEL, profile: opts.against,
        trust: opts.trust === true,
        skillDiscovery: false, extensionDiscovery: false, generatedSkills: false, packages: false,
        subagents: false, repoMap: false, checkpoints: false, supervise: false,
      };
      // This command intentionally has no provider/harness override flags. Tell the shared
      // resolver these values are defaults; an absent Commander source otherwise means an
      // explicit value in legacy entry points and would overwrite the selected profile.
      for (const [key, value] of Object.entries(defaults))
        if (cmd.getOptionValueSource(key) === undefined) cmd.setOptionValueWithSource(key, value, "default");
      const profile = await loadRunConfig(cmd, defaults, dependencies.config);
      const result = await withMaintenanceSignal(signal => evaluateSessions({
        sessions: ids, against: opts.against, fixtures: opts.fixtures, output: opts.output,
        profile: { ...profile, provider: profile.provider ?? "anthropic", model: profile.model ?? DEFAULT_ANTHROPIC_MODEL,
          ...(profile.memory === undefined ? {} : { memory: resolve(dependencies.config?.cwd ?? process.cwd(), profile.memory) }) },
        ...(opts.execute === undefined ? {} : { execute: opts.execute }),
        ...(opts.batchTokens === undefined ? {} : { batchTokens: Number(opts.batchTokens) }),
        ...(opts.batchMinutes === undefined ? {} : { batchMinutes: Number(opts.batchMinutes) }), signal,
      }, dependencies.evaluation), undefined, "evaluation");
      console.log(JSON.stringify(result, null, 2));
      if (opts.execute === true && result.results.some(row => row.type === "eval.result" && (row.outcome === "FAIL" || row.outcome === "BLOCKED"))) process.exitCode = 1;
      } catch (error) {
        // Configuration, file and provider errors may include sensitive input. Only expose a
        // bounded setting-name diagnostic; never forward arbitrary exception messages here.
        const message = error instanceof Error ? error.message : "";
        const unsupported = /^evaluation profile does not support effective field: ([A-Za-z./]+)$/.exec(message);
        throw new Error(unsupported === null ? "Evaluation refused or failed; check the fixture map, supported profile, explicit limits and local image prerequisites. Existing evidence is preserved."
          : `Evaluation profile does not support effective field: ${unsupported[1]}`);
      }
    });

  const sessions = program.command("sessions").description("Inspect session event logs");

  sessions.command("export <id>")
    .description("Export finished materialized messages with heuristic redaction (unknown secrets may remain); no config/providers")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--format <format>", "jsonl, sharegpt or md; versioned canonical fields preserve supported content", "jsonl")
    .option("--redact-file <path>", "JSON array of exact secret strings (64 KiB maximum); no raw bypass")
    .option("--omit-opaque", "explicitly lossy image omission; otherwise opaque content is refused; unknown types always refuse")
    .action(async (id: string, opts: { root: string; format: string; redactFile?: string; omitOpaque?: boolean }) => {
      // Do not use configured(): exports must never read credentials or invoke providers.
      const output = await exportSession(new SessionStore({ root: opts.root }), id, opts);
      process.stdout.write(output);
    });

  sessions.command("undo <id>")
    .description("Restore an owned checkpoint; stop external writers first; preserves index/history and retains originals")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--to-turn <n>", "checkpoint turn (default: latest in the latest run)", sequence)
    .action(async (id: string, opts: {root:string;toTurn?:number}) => {
      const result = await undoSession(new SessionStore({root:opts.root}),id,opts.toTurn===undefined?{}:{toTurn:opts.toTurn});
      console.log(result.message);
    });

  withRunOptions(
    sessions
      .command("resume <id> [task...]")
      .description("Continue a session from its snapshot; the task becomes the next user message"),
    HEADLESS_MAX_TURNS,
  ).action(async (id: string, taskWords: string[], opts: RunOptions, cmd: Command) => {
    const resolved = await configured({ ...opts, resume: id }, cmd, false);
    if (resolved !== undefined) await executeRun(taskWords.join(" ") || "Continue the task.", resolved);
  });

  sessions
    .command("fork <id>")
    .description("Fork a session at a sequence in its own event log (defaults to its latest event)")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--at <seq>", "parent sequence to include", sequence)
    .action(async (id: string, opts: { root: string; at?: number }) => {
      const child = await forkSession(new SessionStore({ root: opts.root }), id, opts.at);
      console.log(child);
    });

  sessions
    .command("search <query...>")
    .description("Search rendered session transcripts with BM25")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .action(async (query: string[], opts: { root: string }) => {
      const text = query.join(" ");
      const hits = await searchSessions(new SessionStore({ root: opts.root }), text);
      for (const hit of hits) console.log(`${hit.id}\t${hit.score.toFixed(3)}\t${hit.snippet}`);
    });

  sessions
    .command("replay <id>")
    .description("Replay a materialized session tree without re-executing tools")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--until <seq>", "last sequence to include from the named session's own log", sequence)
    .action(async (id: string, opts: { root: string; until?: number }) => {
      for (const line of await replaySession(new SessionStore({ root: opts.root }), id, opts.until)) console.log(line);
    });

  sessions
    .command("ls")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .action(async (opts: { root: string }) => {
      const store = new SessionStore({ root: opts.root });
      const refs = await store.list();
      if (refs.length === 0) {
        console.log(`no sessions under ${opts.root}`);
        return;
      }
      for (const r of refs) {
        console.log(`${r.id}\t${new Date(r.updatedAt).toISOString()}\t${r.bytes} B`);
      }
    });

  sessions
    .command("show <id>")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--json", "raw JSONL instead of a timeline")
    .option("--evidence", "claim-to-evidence view for a finished local session (no model call)")
    .action(async (id: string, opts: { root: string; json?: boolean; evidence?: boolean }) => {
      if (opts.evidence && opts.json) throw new Error("--evidence and --json are mutually exclusive");
      const store = new SessionStore({ root: opts.root });
      if (opts.evidence) { console.log(await showSessionEvidence(store, id)); return; }
      for await (const e of store.read(id)) {
        console.log(opts.json ? JSON.stringify(e) : renderEvent(e));
      }
    });

  /**
   * PLAN §5: bare `agentrig` is the interactive TUI.
   *
   * Registered as its own `isDefault` subcommand rather than by putting options on the root
   * program. Options on the root are consumed by Commander *wherever they appear in argv* —
   * including after a subcommand name — unless positional options are enabled. Adding them to the
   * root silently swallowed `--root`, `--model`, `--max-turns` and the rest from every shipped
   * subcommand, which then fell back to its default with no error. An explicit default subcommand
   * keeps the TUI's options on the TUI, and preserves Commander's unknown-command error (and its
   * did-you-mean suggestion) instead of dropping a typo into an interactive agent.
   */
  withRunOptions(
    program.command("tui", { isDefault: true, hidden: true }).description("Interactive TUI (default)"),
    INTERACTIVE_MAX_TURNS,
  )
    .action(async (opts: RunOptions, cmd: Command) => {
      // `isDefault` catches ANY unmatched argv, so a typo'd subcommand would otherwise drop the
      // user into an interactive agent with their intended command discarded. Reject leftover
      // operands the way Commander would have, suggestion included.
      const known = program.commands
        .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
        .map((c) => c.name());
      const complaint = describeStray(cmd.args, known);
      if (complaint !== null) {
        program.error(complaint);
        return;
      }
      const interactive = opts.headless !== true && process.stdin.isTTY === true;
      const resolved = await configured(opts, cmd, interactive);
      if (resolved !== undefined) await executeTui(resolved);
    });


  return program;
}
