import type {
  Agent,
  Decision,
  EventOf,
  HarnessEvent,
  PermissionRequest,
  PlanItem,
  Session,
  Signal,
  Skill,
} from "@agentkitai/agentrig-core";
import { AssistantText, renderChatEvent, renderContextManifest, renderEvent } from "../render.js";
import {
  RESERVED_COMMAND_NAMES,
  composeSkillInvocation,
  helpText,
  parseCommand,
  suggestFor,
  type TuiCommand,
} from "./commands.js";

/**
 * The TUI's brain, deliberately headless.
 *
 * A terminal UI is close to untestable, so the React tree owns nothing but layout: every
 * decision — what a line says, when a permission prompt appears, what a slash command does —
 * lives here where a test can drive it without a screen.
 */

export interface TuiLine {
  key: number;
  text: string;
  tone: "event" | "you" | "system" | "error" | "assistant";
}

export interface PendingPermission {
  req: PermissionRequest;
  /** `remember` applies the answer to every later request for the same tool this session. */
  resolve: (d: Exclude<Decision, "ask">, remember: boolean) => void;
}

export type SupervisorPromptOutcome = "answered" | "expired" | "closed";

export interface PendingEscalation {
  question: string;
  /** `null` settles a prompt that timed out or whose session ended without an answer. */
  resolve: (answer: string | null, reason?: "timeout" | "closed") => void;
}

export type TuiActivity =
  | { kind: "thinking"; startedAt: number }
  | { kind: "tool"; id: string; name: string; startedAt: number; detail?: string };

export interface TuiState {
  lines: TuiLine[];
  status: "idle" | "running" | "ended";
  /** Work currently in flight, derived from the live event stream rather than persisted separately. */
  activity: TuiActivity | null;
  /** The request being shown. Further requests queue behind it rather than replacing it. */
  pending: PendingPermission | null;
  /** How many more are waiting, so the view can say so. */
  queued: number;
  /** A supervisor question accepts free-form input independently of permission yes/no prompts. */
  escalation: PendingEscalation | null;
  /** Latest plan the agent recorded, for `/plan`. */
  plan: PlanItem[];
  /** Latest prompt bill of materials, for `/context`. */
  manifest: EventOf<"context.manifest"> | null;
  /** Signals the supervisor raised this session, for `/supervisor`. */
  signals: Signal[];
  sessionId: string | null;
  turns: number;
  /** The model in use, from session.start (or the flags, before the first task runs). */
  model: string | null;
  /**
   * Tokens the model saw on its most recent call — input plus cache reads plus the reply it
   * produced, which the next call resends. This is the live "how full is the context" gauge; the
   * cumulative totals stay where they were, in the end-of-session summary line.
   */
  context: number | null;
  /** Git branch of the cwd, re-read each turn because the agent itself can check branches out. */
  branch: string | null;
  /** The reply being streamed, shown live and committed when the turn ends. */
  streaming: string;
  /** Whether the raw event trace is shown as well as the conversation. */
  verbose: boolean;
}

export const DEFAULT_ESCALATION_PROMPT_TIMEOUT_MS = 60_000;

const BASH_COMMAND_PREFIX_LENGTH = 32;

function bashCommandPrefix(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  const oneLine = command.replace(/\s+/g, " ").trim();
  if (oneLine === "") return undefined;
  return oneLine.length <= BASH_COMMAND_PREFIX_LENGTH
    ? oneLine
    : `${oneLine.slice(0, BASH_COMMAND_PREFIX_LENGTH - 1)}…`;
}

export interface TuiControllerOptions {
  agent: Agent;
  cwd: string;
  /** `/memory <q>` — returns lines to print. Injected so the controller stays free of stores. */
  onMemory?: (query: string) => Promise<string[]>;
  /** `/dream [--auto]` — returns lines to print. */
  onDream?: (auto: boolean) => Promise<string[]>;
  /** Whether a supervisor is attached; `/supervisor` says so rather than promising an empty list. */
  supervised?: boolean;
  /**
   * Attaches an observer to each session as it starts. Sessions are created in here, so the
   * supervisor cannot be attached from outside — which is why `--supervise` was accepted by the
   * TUI and silently did nothing: every detector, the whole ladder, the reviewer and the grader
   * were unreachable from the default entry point.
   */
  onSession?: (session: Session) => void;
  /**
   * Cap on retained lines. Generous because `Static` renders each line once — the old 500 was
   * sized for a live tree whose cost grew with the buffer.
   */
  maxLines?: number;
  /** Shown in the statusline before the first session starts; session.start overrides it. */
  model?: string;
  /**
   * Returns the cwd's git branch, or null off a repo. Injected — the controller stays free of
   * filesystem reads so a test can drive the statusline without building a repository.
   */
  branch?: () => string | null;
}

export class TuiController {
  private state: TuiState = {
    lines: [],
    status: "idle",
    activity: null,
    pending: null,
    queued: 0,
    escalation: null,
    plan: [],
    manifest: null,
    signals: [],
    sessionId: null,
    turns: 0,
    model: null,
    context: null,
    branch: null,
    streaming: "",
    verbose: false,
  };
  private listeners = new Set<(s: TuiState) => void>();
  private readonly assistant = new AssistantText();
  /** Tool name -> standing answer for this session. Never written to disk. */
  private readonly standing = new Map<string, Exclude<Decision, "ask">>();
  /**
   * Whether the current session can be continued. Set by a completed turn, because that is when
   * the loop writes the snapshot a resume reads — a session that died before finishing a turn
   * has nothing to resume from, and asking would lose the next prompt to an error.
   */
  private resumable = false;
  private session: Session | null = null;
  /** Requests waiting behind the one on screen. */
  private readonly queue: PendingPermission[] = [];
  private running: Promise<void> | null = null;
  private agent: Agent;
  private nextKey = 0;
  private readonly maxLines: number;

  constructor(private readonly opts: TuiControllerOptions) {
    this.maxLines = opts.maxLines ?? 5_000;
    this.agent = opts.agent;
    this.memory = opts.onMemory;
    this.dream = opts.onDream;
    if (opts.model !== undefined) this.state = { ...this.state, model: opts.model };
    this.refreshBranch();
  }

  /** Re-reads the branch through the injected reader; a throw shows as no branch, not a crash. */
  private refreshBranch(): void {
    let branch: string | null = null;
    try {
      branch = this.opts.branch?.() ?? null;
    } catch {
      branch = null;
    }
    if (branch !== this.state.branch) this.set({ branch });
  }

  /** The agent is assembled after the controller, because it needs the controller's `onAsk`. */
  attach(agent: Agent): void {
    this.agent = agent;
  }

  setMemory(fn: (query: string) => Promise<string[]>): void {
    this.memory = fn;
  }

  setDream(fn: (auto: boolean) => Promise<string[]>): void {
    this.dream = fn;
  }

  /** The loaded catalogue, for `/skills` and `/<skill-name>`. Set after buildAgent discovers it. */
  setSkills(skills: Skill[]): void {
    this.skills = skills;
  }

  private memory: ((query: string) => Promise<string[]>) | undefined;
  private dream: ((auto: boolean) => Promise<string[]>) | undefined;
  private skills: Skill[] = [];

  subscribe(fn: (s: TuiState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  snapshot(): TuiState {
    return this.state;
  }

  private set(patch: Partial<TuiState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  print(text: string, tone: TuiLine["tone"] = "system"): void {
    const lines = [...this.state.lines, { key: this.nextKey++, text, tone }];
    // Append-only, ALWAYS. Ink's `Static` remembers how many items it has already written and
    // renders `items.slice(thatIndex)`. Dropping items off the front shifts every index, the
    // remembered one runs past the end, and the TUI silently stops printing ANYTHING for the rest
    // of the session — which is exactly what the `slice(-maxLines)` here used to do, at the 5,000th
    // line of a long run, with no error and no clue.
    //
    // The cap still binds what is retained, just not the array's shape: a line past it has already
    // been written to the terminal and is never read again, so its text is released and its slot
    // stays where `Static` left it. Exactly one line falls out of the window per print.
    const over = lines.length - this.maxLines;
    const dropped = over > 0 ? lines[over - 1] : undefined;
    if (dropped !== undefined && dropped.text !== "") lines[over - 1] = { ...dropped, text: "" };
    this.set({ lines });
  }

  /** The `onAsk` handler an agent is built with: bridges a promise to a rendered prompt. */
  readonly ask = (req: PermissionRequest): Promise<Exclude<Decision, "ask">> =>
    new Promise((resolve) => {
      // A standing answer for this tool: asked once, applied thereafter. Being asked to approve
      // every single write in a twenty-file task is how a permission prompt stops being read at
      // all, which is worse than not having one.
      const standing = this.standing.get(req.tool);
      if (standing !== undefined) {
        resolve(standing);
        return;
      }
      const entry: PendingPermission = {
        req,
        resolve: (d, remember) => {
          if (remember === true) {
            this.standing.set(req.tool, d);
            this.print(
              `${d === "allow" ? "allowing" : "denying"} ${req.tool} for the rest of this session (/permissions to review)`,
              d === "allow" ? "system" : "error",
            );
          } else {
            this.print(`${d === "allow" ? "allowed" : "denied"} ${req.tool}`, d === "allow" ? "system" : "error");
          }
          resolve(d);
          this.advanceQueue();
        },
      };
      // A single slot silently overwrote the first resolver when two requests overlapped,
      // leaving its promise unsettled and the loop wedged with no diagnostic. Core runs tool
      // calls sequentially today, so that is latent rather than live — but parallel tool
      // execution is an obvious near-term change, and a queue costs nothing now.
      if (this.state.pending === null) this.set({ pending: entry });
      else {
        this.queue.push(entry);
        this.set({ queued: this.queue.length });
      }
    });

  private advanceQueue(): void {
    const next = this.queue.shift();
    this.set({ pending: next ?? null, queued: this.queue.length });
  }

  /**
   * `remember` makes the answer standing for that tool, for this session only. Deliberately not
   * persisted: a blanket grant written to disk is a decision that outlives the task it was made
   * for, and nobody would remember making it.
   */
  answerPermission(d: Exclude<Decision, "ask">, remember = false): void {
    this.state.pending?.resolve(d, remember);
  }

  /**
   * Makes the supervisor's escalation rung an actual free-form prompt. The promise is bounded even
   * when this is used outside `supervise()` (which has its own safety timeout), and session teardown
   * settles it too, so an absent user can never wedge shutdown.
   */
  askSupervisor(question: string, timeoutMs = DEFAULT_ESCALATION_PROMPT_TIMEOUT_MS): Promise<SupervisorPromptOutcome> {
    // The supervisor currently serializes interventions, but replacing rather than orphaning an
    // existing prompt keeps this seam safe for another caller or future parallel observers.
    this.state.escalation?.resolve(null, "closed");
    return new Promise((done) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: PendingEscalation = {
        question,
        resolve: (answer, reason = "timeout") => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (this.state.escalation === entry) this.set({ escalation: null });

          const guidance = answer?.trim() ?? "";
          const outcome: SupervisorPromptOutcome = answer !== null
            ? "answered"
            : reason === "timeout" ? "expired" : "closed";
          if (guidance !== "") {
            if (this.session !== null) {
              this.session.control.steer(`[user response to supervisor] ${guidance}`, "user");
              this.print(`answered supervisor: ${guidance}`, "you");
            } else {
              this.print("the supervisor answer arrived after the session ended and was not sent", "error");
            }
          } else if (outcome === "expired") {
            this.print("supervisor escalation expired with no answer; the run will continue", "system");
          } else if (outcome === "closed") {
            this.print("supervisor escalation closed before an answer", "system");
          }
          done(outcome);
        },
      };
      timer = setTimeout(() => entry.resolve(null, "timeout"), timeoutMs);
      timer.unref?.();
      this.set({ escalation: entry });
    });
  }

  answerEscalation(answer: string): void {
    this.state.escalation?.resolve(answer);
  }

  /** What has a standing answer, and how to take it back. */
  private describeStanding(): string {
    if (this.standing.size === 0) {
      return "nothing has a standing answer — every request is asked. `a` at a prompt makes one standing.";
    }
    const lines = [...this.standing].map(([tool, d]) => `  ${d === "allow" ? "allow" : "deny "} ${tool}`);
    return [...lines, "/permissions reset clears these"].join("\n");
  }

  /** Settles every outstanding request as a denial — nothing may be dropped unsettled. */
  private denyAllPending(): void {
    const all = [this.state.pending, ...this.queue].filter((p): p is PendingPermission => p !== null);
    this.queue.length = 0;
    this.state = { ...this.state, pending: null, queued: 0 };
    for (const p of all) p.resolve("deny", false);
  }

  abort(): void {
    if (this.session === null) {
      this.print("nothing running", "system");
      return;
    }
    this.session.control.abort();
    // a pending prompt would otherwise hold the loop open waiting for an answer nobody will give
    this.denyAllPending();
    this.print("aborting…", "error");
  }

  /**
   * Stops anything still running and waits for it. Called when the UI closes: a session left
   * running with the terminal gone keeps executing tools and billing, unwatched.
   */
  async shutdown(): Promise<void> {
    if (this.session !== null) this.abort();
    // unconditionally: a request can be outstanding with no session running (the loop is blocked
    // inside onAsk), and leaving it unsettled is a promise that can never resolve
    this.denyAllPending();
    this.state.escalation?.resolve(null, "closed");
    await this.running?.catch(() => {});
  }

  /** Handles one submitted line. Returns false when the app should exit. */
  async submit(line: string): Promise<boolean> {
    const cmd = parseCommand(line);
    if (cmd === null) return true;
    if (cmd.kind !== "task") this.print(line, "you");
    return this.run(cmd);
  }

  private async run(cmd: TuiCommand): Promise<boolean> {
    switch (cmd.kind) {
      case "quit":
        // stop the work before tearing the UI down, or the session runs on invisibly
        if (this.session !== null) {
          this.print("stopping the running turn before exiting…", "system");
          await this.shutdown();
        }
        return false;
      case "help":
        this.print(helpText(), "system");
        return true;
      case "abort":
        this.abort();
        return true;
      case "plan":
        this.print(
          this.state.plan.length === 0
            ? "no plan recorded yet — the agent writes one with update_plan"
            : this.state.plan.map((i) => `  [${i.status}] ${i.text}`).join("\n"),
          "system",
        );
        return true;
      case "context":
        this.print(
          this.state.manifest === null
            ? "no context manifest recorded yet — run a turn first"
            : renderContextManifest(this.state.manifest),
          "system",
        );
        return true;
      case "supervisor":
        this.print(
          this.opts.supervised !== true
            ? "no supervisor is attached to this session — nothing can be signalled"
            : this.state.signals.length === 0
            ? "the supervisor has raised nothing this session"
            : this.state.signals
                .map((s) => `  ${s.type} (${s.confidence.toFixed(2)}): ${s.evidence.join("; ")}`)
                .join("\n"),
          "system",
        );
        return true;
      case "memory":
        await this.delegate("memory", () => this.memory?.(cmd.query));
        return true;
      case "dream":
        await this.delegate("dream", () => this.dream?.(cmd.auto));
        return true;
      case "resume":
        if (cmd.id === "") this.print("usage: /resume <session-id>", "error");
        else {
          // trust the id the user named: they are asking for a session this process never ran
          this.resumable = true;
          await this.start("Continue the task.", { resume: cmd.id });
        }
        return true;
      case "permissions":
        if (cmd.reset) {
          const had = this.standing.size;
          this.standing.clear();
          this.print(had === 0 ? "nothing to reset" : `cleared ${had} standing answer(s)`, "system");
        } else {
          this.print(this.describeStanding(), "system");
        }
        return true;
      case "verbose": {
        const verbose = !this.state.verbose;
        this.set({ verbose });
        this.print(
          verbose
            ? "verbose: showing the raw event trace as well as the conversation"
            : "verbose: off — showing the conversation only",
          "system",
        );
        return true;
      }
      case "skills": {
        if (this.skills.length === 0) {
          this.print("no skills loaded — add .agentrig/skills/ to the project or configure `skills` dirs", "system");
          return true;
        }
        const lines = this.skills.map((s) => {
          const first = s.name.split(/\s+/)[0]!.toLowerCase();
          const marker = RESERVED_COMMAND_NAMES.has(s.name.toLowerCase())
            ? ` (shadowed by the built-in /${s.name.toLowerCase()} — invoke via the skill tool only)`
            : first !== s.name.toLowerCase()
            ? " (name has spaces — not /-invocable)"
            : "";
          return `  /${s.name}${marker} — ${s.description}`;
        });
        this.print(["loaded skills (run one with /<skill-name> [task...]):", ...lines].join("\n"), "system");
        return true;
      }
      case "skill": {
        const skill = this.skills.find((s) => s.name.toLowerCase() === cmd.name.toLowerCase());
        if (skill === undefined) {
          // same treatment as a typo'd built-in, because from the user's seat it is one.
          // Suggest only what can actually be typed back: no "?" alias, no names with spaces.
          const suggestion = suggestFor(cmd.name, [
            ...[...RESERVED_COMMAND_NAMES].filter((n) => n !== "?"),
            ...this.skills.map((s) => s.name).filter((n) => !/\s/.test(n)),
          ]);
          this.print(
            `unknown command /${cmd.name}${suggestion === null ? "" : ` — did you mean /${suggestion}?`}\n${helpText()}`,
            "error",
          );
          return true;
        }
        // Checked HERE, not left to start()'s own guard: printing "loaded" first and letting
        // start() refuse would tell the user the skill went in when it was silently dropped.
        if (this.state.status === "running") {
          this.print("a turn is already running — /abort first", "error");
          return true;
        }
        const composed = composeSkillInvocation(skill, cmd.args);
        this.print(`skill "${skill.name}" loaded into this turn (${composed.length} chars)`, "system");
        await this.continueConversation(composed);
        return true;
      }
      case "unknown":
        this.print(`unknown command ${cmd.name === "" ? "/" : `/${cmd.name}`}\n${helpText()}`, "error");
        return true;
      case "task":
        this.print(cmd.text, "you");
        await this.continueConversation(cmd.text);
        return true;
      case "new":
        this.resumable = false;
        // context is per-conversation and the next session starts empty; the model persists
        this.set({ sessionId: null, plan: [], signals: [], turns: 0, context: null });
        this.print("starting fresh — the next task begins a new session", "system");
        return true;
      default:
        return true;
    }
  }

  /** Runs an injected side command, reporting rather than throwing into the render loop. */
  private async delegate(name: string, fn: () => Promise<string[]> | undefined): Promise<void> {
    const work = fn();
    if (work === undefined) {
      this.print(`/${name} is not available in this session`, "error");
      return;
    }
    try {
      for (const l of await work) this.print(l, "system");
    } catch (err) {
      this.print(`/${name} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /**
   * One user turn continuing the current conversation (or starting the first session). Tasks and
   * `/skill-name` invocations share this so the continuation spread cannot drift between them —
   * every prompt used to be its own session, and nothing the user said was ever in scope for
   * what they said next.
   */
  private continueConversation(text: string): Promise<void> {
    return this.start(text, {
      cwd: this.opts.cwd,
      ...(this.state.sessionId !== null && this.resumable ? { resume: this.state.sessionId } : {}),
    });
  }

  private async start(task: string, opts: { cwd?: string; resume?: string }): Promise<void> {
    if (this.state.status === "running") {
      this.print("a turn is already running — /abort first", "error");
      return;
    }
    let session: Session;
    try {
      session = this.agent.run(task, opts);
    } catch (err) {
      this.print(`could not start: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    this.session = session;
    // before the events are consumed: an observer attached late misses the start of the session
    // it is meant to be watching
    try {
      this.opts.onSession?.(session);
    } catch (err) {
      this.print(`supervisor could not attach: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    // a continued session keeps the plan and the signals it already had; only a new one clears
    this.set({
      status: "running",
      activity: null,
      sessionId: session.id,
      manifest: null,
      ...(opts.resume === undefined ? { plan: [], signals: [] } : {}),
    });

    const work = this.drive(session);
    this.running = work;
    await work;
  }

  private async drive(session: Session): Promise<void> {
    try {
      for await (const e of session.events) this.consume(e);
      const summary = await session.done;
      this.set({ turns: summary.turns });
      this.print(
        `${summary.reason} after ${summary.turns} turn(s), ${summary.usage.input} in / ${summary.usage.output} out`,
        summary.reason === "done" ? "system" : "error",
      );
      if (summary.error !== undefined) this.print(summary.error, "error");
    } catch (err) {
      this.print(`session failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      this.session = null;
      this.running = null;
      // settle rather than drop: clearing either prompt would leave a resolver unsettled and the
      // loop or supervisor waiting on a promise that can never resolve
      this.denyAllPending();
      this.state.escalation?.resolve(null, "closed");
      this.set({ status: "idle", activity: null });
    }
  }

  private trackActivity(e: HarnessEvent): void {
    if (e.type === "model.request") {
      this.set({ activity: { kind: "thinking", startedAt: e.ts } });
      return;
    }
    if (
      (e.type === "model.delta" || e.type === "model.response") &&
      this.state.activity?.kind === "thinking"
    ) {
      this.set({ activity: null });
      return;
    }
    if (e.type === "tool.call") {
      const detail = e.name === "bash" ? bashCommandPrefix(e.input) : undefined;
      this.set({
        activity: {
          kind: "tool",
          id: e.id,
          name: e.name,
          startedAt: e.ts,
          ...(detail === undefined ? {} : { detail }),
        },
      });
      return;
    }
    if (e.type === "tool.result" && this.state.activity?.kind === "tool" && this.state.activity.id === e.id) {
      this.set({ activity: null });
      return;
    }
    // Defensive terminal boundaries: provider failures and aborts need not produce the usual
    // response/result closer, and session-end hooks may keep the UI alive after a fatal error.
    if (
      this.state.activity !== null &&
      (e.type === "turn.end" ||
        e.type === "session.end" ||
        (e.type === "error" && (e.fatal || e.message.startsWith("model request refused by hook:"))))
    ) {
      this.set({ activity: null });
    }
  }

  private consume(e: HarnessEvent): void {
    this.trackActivity(e);
    if (e.type === "plan.updated") this.set({ plan: e.items });
    if (e.type === "context.manifest") this.set({ manifest: e });
    if (e.type === "supervisor.signal") this.set({ signals: [...this.state.signals, e.signal] });
    if (e.type === "session.start" || e.type === "session.resume") {
      // the event says what is actually running, which beats whatever the flags claimed
      this.set({ model: e.model });
      this.refreshBranch();
    }
    if (e.type === "model.response") {
      // The Usage fields are disjoint (see core's Usage schema), so what the model saw is their
      // sum — cache writes included: on the first call of a session the cached prefix is a write,
      // not a read, and dropping it showed a near-zero gauge until the second call. The output is
      // resent on the next call, so the total is the size of the conversation as it stands.
      const u = e.usage;
      const total = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + u.output;
      // All-zero usage is a provider that reported nothing (core prints a warning for it), not a
      // zero-token conversation — keep the last honest reading rather than asserting "ctx 0".
      if (total > 0) this.set({ context: total });
    }
    if (e.type === "turn.end") {
      this.set({ turns: e.n });
      // the agent may have moved the working tree — a checkout mid-task should show
      this.refreshBranch();
      // the loop writes its resume snapshot after every turn.end, so this is exactly when the
      // session becomes continuable
      this.resumable = true;
    }

    // The reply is the point of the whole exercise. `model.delta` is per-token, so it streams
    // into a live line rather than one printed line per token, and is committed when its turn
    // ends. Dropping it outright — which both surfaces used to do — meant the agent never showed
    // an answer at all.
    const finished = this.assistant.push(e);
    if (e.type === "model.delta") {
      this.set({ streaming: this.assistant.pending });
      return;
    }
    if (finished !== null) {
      this.print(finished, "assistant");
      this.set({ streaming: "" });
    }

    if (this.state.verbose) {
      this.print(renderEvent(e), e.type === "error" ? "error" : "event");
      return;
    }
    const line = renderChatEvent(e);
    if (line !== null) this.print(line, e.type === "error" ? "error" : "event");
  }
}
