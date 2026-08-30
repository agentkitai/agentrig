import type {
  Agent,
  Decision,
  HarnessEvent,
  PermissionRequest,
  PlanItem,
  Session,
  Signal,
} from "@agentkitai/agentrig-core";
import { AssistantText, renderChatEvent, renderEvent } from "../render.js";
import { helpText, parseCommand, type TuiCommand } from "./commands.js";

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
  resolve: (d: Exclude<Decision, "ask">) => void;
}

export interface TuiState {
  lines: TuiLine[];
  status: "idle" | "running" | "ended";
  /** The request being shown. Further requests queue behind it rather than replacing it. */
  pending: PendingPermission | null;
  /** How many more are waiting, so the view can say so. */
  queued: number;
  /** Latest plan the agent recorded, for `/plan`. */
  plan: PlanItem[];
  /** Signals the supervisor raised this session, for `/supervisor`. */
  signals: Signal[];
  sessionId: string | null;
  turns: number;
  /** The reply being streamed, shown live and committed when the turn ends. */
  streaming: string;
  /** Whether the raw event trace is shown as well as the conversation. */
  verbose: boolean;
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
   * Cap on retained lines. Generous because `Static` renders each line once — the old 500 was
   * sized for a live tree whose cost grew with the buffer.
   */
  maxLines?: number;
}

export class TuiController {
  private state: TuiState = {
    lines: [],
    status: "idle",
    pending: null,
    queued: 0,
    plan: [],
    signals: [],
    sessionId: null,
    turns: 0,
    streaming: "",
    verbose: false,
  };
  private listeners = new Set<(s: TuiState) => void>();
  private readonly assistant = new AssistantText();
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

  private memory: ((query: string) => Promise<string[]>) | undefined;
  private dream: ((auto: boolean) => Promise<string[]>) | undefined;

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
    this.set({ lines: lines.length > this.maxLines ? lines.slice(-this.maxLines) : lines });
  }

  /** The `onAsk` handler an agent is built with: bridges a promise to a rendered prompt. */
  readonly ask = (req: PermissionRequest): Promise<Exclude<Decision, "ask">> =>
    new Promise((resolve) => {
      const entry: PendingPermission = {
        req,
        resolve: (d) => {
          this.print(`${d === "allow" ? "allowed" : "denied"} ${req.tool}`, d === "allow" ? "system" : "error");
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

  answerPermission(d: Exclude<Decision, "ask">): void {
    this.state.pending?.resolve(d);
  }

  /** Settles every outstanding request as a denial — nothing may be dropped unsettled. */
  private denyAllPending(): void {
    const all = [this.state.pending, ...this.queue].filter((p): p is PendingPermission => p !== null);
    this.queue.length = 0;
    this.state = { ...this.state, pending: null, queued: 0 };
    for (const p of all) p.resolve("deny");
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
        else await this.start("Continue the task.", { resume: cmd.id });
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
      case "unknown":
        this.print(`unknown command ${cmd.name === "" ? "/" : `/${cmd.name}`}\n${helpText()}`, "error");
        return true;
      case "task":
        this.print(cmd.text, "you");
        await this.start(cmd.text, { cwd: this.opts.cwd });
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
    this.set({ status: "running", sessionId: session.id, plan: [], signals: [] });

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
      // settle rather than drop: clearing `pending` would leave a resolver unsettled and the
      // loop waiting on a promise that can never resolve
      this.denyAllPending();
      this.set({ status: "idle" });
    }
  }

  private consume(e: HarnessEvent): void {
    if (e.type === "plan.updated") this.set({ plan: e.items });
    if (e.type === "supervisor.signal") this.set({ signals: [...this.state.signals, e.signal] });
    if (e.type === "turn.end") this.set({ turns: e.n });

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
