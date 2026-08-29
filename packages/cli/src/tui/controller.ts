import type {
  Agent,
  Decision,
  HarnessEvent,
  PermissionRequest,
  PlanItem,
  Session,
  Signal,
} from "@agentkitai/agentrig-core";
import { renderEvent } from "../render.js";
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
  tone: "event" | "you" | "system" | "error";
}

export interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: Exclude<Decision, "ask">) => void;
}

export interface TuiState {
  lines: TuiLine[];
  status: "idle" | "running" | "ended";
  pending: PendingPermission | null;
  /** Latest plan the agent recorded, for `/plan`. */
  plan: PlanItem[];
  /** Signals the supervisor raised this session, for `/supervisor`. */
  signals: Signal[];
  sessionId: string | null;
  turns: number;
}

export interface TuiControllerOptions {
  agent: Agent;
  cwd: string;
  /** `/memory <q>` — returns lines to print. Injected so the controller stays free of stores. */
  onMemory?: (query: string) => Promise<string[]>;
  /** `/dream [--auto]` — returns lines to print. */
  onDream?: (auto: boolean) => Promise<string[]>;
  /** Cap on retained lines; a long session must not grow the terminal buffer without bound. */
  maxLines?: number;
}

export class TuiController {
  private state: TuiState = {
    lines: [],
    status: "idle",
    pending: null,
    plan: [],
    signals: [],
    sessionId: null,
    turns: 0,
  };
  private listeners = new Set<(s: TuiState) => void>();
  private session: Session | null = null;
  private nextKey = 0;
  private readonly maxLines: number;

  constructor(private readonly opts: TuiControllerOptions) {
    this.maxLines = opts.maxLines ?? 500;
  }

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
      this.set({
        pending: {
          req,
          resolve: (d) => {
            this.set({ pending: null });
            this.print(`${d === "allow" ? "allowed" : "denied"} ${req.tool}`, d === "allow" ? "system" : "error");
            resolve(d);
          },
        },
      });
    });

  answerPermission(d: Exclude<Decision, "ask">): void {
    this.state.pending?.resolve(d);
  }

  abort(): void {
    if (this.session === null) {
      this.print("nothing running", "system");
      return;
    }
    this.session.control.abort();
    // a pending prompt would otherwise hold the loop open waiting for an answer nobody will give
    this.state.pending?.resolve("deny");
    this.print("aborting…", "error");
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
          this.state.signals.length === 0
            ? "the supervisor has raised nothing this session"
            : this.state.signals
                .map((s) => `  ${s.type} (${s.confidence.toFixed(2)}): ${s.evidence.join("; ")}`)
                .join("\n"),
          "system",
        );
        return true;
      case "memory":
        await this.delegate("memory", () => this.opts.onMemory?.(cmd.query));
        return true;
      case "dream":
        await this.delegate("dream", () => this.opts.onDream?.(cmd.auto));
        return true;
      case "resume":
        if (cmd.id === "") this.print("usage: /resume <session-id>", "error");
        else await this.start(cmd.id === "" ? "Continue." : "Continue the task.", { resume: cmd.id });
        return true;
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
      session = this.opts.agent.run(task, opts);
    } catch (err) {
      this.print(`could not start: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    this.session = session;
    this.set({ status: "running", sessionId: session.id, plan: [], signals: [] });

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
      // a prompt left pending after the loop exits would block every later turn
      this.set({ status: "idle", pending: null });
    }
  }

  private consume(e: HarnessEvent): void {
    // model.delta is per-token; rendering each as its own line would drown everything else
    if (e.type === "model.delta") return;
    if (e.type === "plan.updated") this.set({ plan: e.items });
    if (e.type === "supervisor.signal") this.set({ signals: [...this.state.signals, e.signal] });
    if (e.type === "turn.end") this.set({ turns: e.n });
    this.print(renderEvent(e), e.type === "error" ? "error" : "event");
  }
}
