import { Command, InvalidArgumentError } from "commander";
import { createInterface } from "node:readline/promises";
import { SessionStore } from "@agentkitai/agentrig-core";
import { DreamLimitsSchema, IngestLimitsSchema, ScanLimitsSchema } from "@agentkitai/agentrig-memory";
import { renderEvent } from "./render.js";
import { forkSession, replaySession, searchSessions } from "./sessions.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_SESSIONS_DIR, runCommand, type RunOptions } from "./run.js";
import { loginCommand } from "./login.js";
import { dreamCommand, type DreamOptions } from "./dream.js";
import { startTui } from "./tui/start.js";
import { loadRunConfig, type LoadRunConfigOptions } from "./config.js";

function parseIngestLimits(text: string) {
  try { return IngestLimitsSchema.parse(JSON.parse(text)); }
  catch (error) { throw new InvalidArgumentError(`invalid ingest limits: ${String(error)}`); }
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
  memorySearch,
  memoryShow,
  type MemoryIngestOptions,
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
  run?: typeof runCommand;
  tui?: typeof startTui;
  config?: LoadRunConfigOptions;
  doctor?: DoctorOptions;
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
  const PROFILE_AWARE = new Set(["run", "tui", "doctor", "resume"]);
  program.hook("preAction", (_thisCommand, actionCommand) => {
    // A profile aimed at a command that never consults config is accepted so aliases keep
    // working, but never silently: an ignored flag the user typed deserves a note (the same
    // contract bash's background timeoutMs settled on).
    const profile = (actionCommand.optsWithGlobals() as { profile?: string }).profile;
    if (profile !== undefined && !PROFILE_AWARE.has(actionCommand.name())) {
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
      .option("--max-tokens-per-turn <n>", "max_tokens per model response", "8192")
      .option("--supervise", "attach the supervisor: heuristic detectors + escalating policy ladder")
      .option("--supervisor-abort", "allow the supervisor's final ladder rung to abort the session")
      .option("--supervisor-no-abort", "compatibility no-op: abort is disabled unless --supervisor-abort is set")
      .option("--supervisor-soft <fraction>", "fraction of the budget at which the soft warning trips", "0.8")
      .option(
        "--supervisor-turns-remaining <n>",
        "warn when this many turns remain, even if the soft fraction has not tripped",
        "15",
      )
      .option(
        "--supervisor-review",
        "enable the LLM-backed supervisor rungs (trajectory reviewer + rubric grader); costs tokens",
      )
      .option("--ingest-on-end", "distil this session into the wiki when it finishes (PLAN §3.2); costs tokens")
      .option("--dream-on-end", "run the scheduled dream when one is due (PLAN §3.7); reports, never applies")
      .option("--dream-every-sessions <n>", "sessions since the last dream before one is due", "10")
      .option("--dream-every-hours <n>", "hours since the last dream before one is due", "24")
      .option("--dream-structural-only", "the scheduled dream skips the model-backed pass — free, no tokens")
      .option("--dream-scan-limits <json>", "wiki/raw scan limits (JSON object; includes scheduler enumeration)", parseDreamScanLimits)
      .option("--dream-limits <json>", "dream lifetime/model limits (JSON object)", parseDreamLimits)
      .option("--mcp-config <path>", "JSON file of MCP servers whose tools are added to this session")
      .option("--subagents", "give the agent a `subagent` tool for context-isolated sub-tasks")
      .option("--subagent-max-turns <n>", "turn budget for each subagent", "15")
      .option("--subagent-max-children <n>", "subagents one session may run in total", "8")
      .option("--skills <dir>", "directory of markdown skills; earlier dirs shadow later (repeatable)", collect, [])
      .option(
        "--skill-discovery",
        "override config and auto-load .agentrig/skills from the trusted project root and home",
      )
      .option("--no-skill-discovery", "do not auto-load conventional .agentrig/skills directories")
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
    program.command("run <task>").description("Run the agent on a task, non-interactively"),
    HEADLESS_MAX_TURNS,
  )
    .option("--resume <id>", "continue an existing session from its snapshot")
    .action(async (task: string, opts: RunOptions, cmd: Command) => {
      // `run` is a headless entry point even when launched from a terminal.
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await executeRun(task, resolved);
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

  const memory = program.command("memory").description("Inspect and maintain the LLM Wiki memory");
  const memoryDir = (cmd: Command): Command =>
    cmd.option("-d, --dir <dir>", "memory directory", ".agentrig");

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
  memoryDir(memory.command("promote <path>").description("Review runtime-backed promotion evidence; publish only with --confirm"))
    .option("--confirm", "publish after reviewing claim-level evidence (eligibility is still required)")
    .action(async (path: string, opts: { dir: string; confirm?: boolean }) => memoryPromote(path, opts));
  memoryDir(memory.command("lint").description("Dry-run dream report — structural only, no model call, no output store"))
    .option("--dream-scan-limits <json>", "wiki/raw scan limits (JSON object)", parseDreamScanLimits)
    .option("--dream-limits <json>", "dream lifetime/model limits (JSON object)", parseDreamLimits)
    .action(async (opts: { dir: string; profile?: string }, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await memoryLint(resolved);
    });
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
    .action(async (opts: DreamOptions, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await dreamCommand({ ...resolved, modelExplicit: modelExplicit(cmd) || resolved.modelExplicit === true });
    });

  program
    .command("doctor")
    .description("Diagnose configuration, credentials, project state, and local prerequisites (read-only)")
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

  const sessions = program.command("sessions").description("Inspect session event logs");

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
    .action(async (id: string, opts: { root: string; json?: boolean }) => {
      const store = new SessionStore({ root: opts.root });
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
