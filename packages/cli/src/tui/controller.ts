import type {
  Agent,
  Decision,
  EventOf,
  HarnessEvent,
  PermissionRequest,
  PermissionAskContext,
  PlanItem,
  Session,
  RunOptions,
  Signal,
  Skill,
  ExtensionCommand,
} from "@agentkitai/agentrig-core";
import { PermissionGrantRegistry } from "@agentkitai/agentrig-core";
import { ToolSummaries } from "./tool-summaries.js";
import { initialPermissionScope, MAX_SCOPE_TEXT, permissionEffectLines, proposedPermissionGrant,
  type ScopeKind } from "./permission-prompt.js";
import { AssistantText, AuxiliaryText, formatUsage, renderChatEvent, renderContextManifest, renderEvent, renderPlanAcceptance } from "../render.js";
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

export interface PendingQuestion {
  signal: AbortSignal;
  request: import("@agentkitai/agentrig-core").QuestionRequest;
  resolve(answer: import("@agentkitai/agentrig-core").QuestionReply | null): void;
}

export interface TuiLine {
  key: number;
  text: string;
  tone: "event" | "you" | "system" | "error" | "assistant";
}

export interface PendingPermission {
  req: PermissionRequest;
  permissionGrants?: PermissionGrantRegistry;
  scope?: { kind: ScopeKind; text: string; preview: boolean; error?: string };
  /** `remember` applies the answer to every later request for the same tool this session. */
  resolve: (d: Exclude<Decision, "ask">, remember: boolean, scope?: { kind: ScopeKind; text: string }) => void;
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

/** A subagent this session spawned, as its own log recorded it: id, label, and how it ended. */
export interface TuiChild {
  id: string;
  task: string;
  /** From the live stream; absent when the list was seeded from a log on resume. */
  spawnedAt?: number;
  reason?: string;
}

export interface TuiState {
  reviewing?: boolean;
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
  question: PendingQuestion | null;
  queuedQuestions: number;
  /** Latest plan the agent recorded, for `/plan`. */
  plan: PlanItem[];
  /** Latest prompt bill of materials, for `/context`. */
  manifest: EventOf<"context.manifest"> | null;
  /** Signals the supervisor raised this session, for `/supervisor`. */
  signals: Signal[];
  /** Subagents this session spawned, in spawn order, for `/children`. */
  children: TuiChild[];
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

/** The parent-side record of a child, folded from the parent's own spawn/end events (R3d). */
export function applyChildEvent(children: readonly TuiChild[], e: HarnessEvent): TuiChild[] {
  if (e.type === "subagent.spawn") return [...children, { id: e.id, task: e.task, spawnedAt: e.ts }];
  if (e.type === "subagent.end") {
    return children.map((c) => (c.id === e.id ? { ...c, reason: e.reason ?? "ended" } : c));
  }
  return [...children];
}

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
  permissionGrants?: PermissionGrantRegistry;
  cwd: string;
  /** `/memory <q>` — returns lines to print. Injected so the controller stays free of stores. */
  onMemory?: (query: string) => Promise<string[]>;
  /** `/dream [--auto]` — returns lines to print. */
  onDream?: (auto: boolean, signal: AbortSignal) => Promise<string[]>;
  onReview?: (args: string, signal: AbortSignal) => Promise<string[]>;
  /**
   * `/fork [seq]` and `/tree` (R3c). Injected like the others so the controller never touches the
   * session store: the TUI reads and writes logs only through the agent, and a fork is the one
   * exception — it writes a new log, never the current one.
   */
  onFork?: (parent: string, atSeq?: number) => Promise<{ id: string; atSeq: number }>;
  onUndo?: (id: string, toTurn?: number) => Promise<{restored:boolean;message:string}>;
  onTree?: (id: string) => Promise<string[]>;
  /**
   * `/children` (R3d): given what this session's log recorded at spawn and end, returns the
   * rendered live tree read from each child's own log. Read-only by contract.
   */
  onChildren?: (children: ReadonlyArray<TuiChild>, now: number, parent: string) => Promise<string[]>;
  /**
   * `/resume <id>` of a session this process did not run: what that session's own log says it
   * spawned, so `/children` is not empty (or worse, the previous session's list) after a resume.
   */
  onSpawned?: (id: string) => Promise<TuiChild[]>;
  /** Whether a supervisor is attached; `/supervisor` says so rather than promising an empty list. */
  supervised?: boolean;
  /**
   * Attaches an observer to each session as it starts. Sessions are created in here, so the
   * supervisor cannot be attached from outside — which is why `--supervise` was accepted by the
   * TUI and silently did nothing: every detector, the whole ladder, the reviewer and the grader
   * were unreachable from the default entry point.
   */
  /** May return a detachable observer; legacy incidental return values are ignored. */
  onSession?: (session: Session) => unknown;
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
    question: null,
    queuedQuestions: 0,
    plan: [],
    manifest: null,
    signals: [],
    children: [],
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
  private readonly auxiliary = new AuxiliaryText();
  /** Same live core registry is passed to the agent; persisted events never restore authority. */
  readonly permissionGrants: PermissionGrantRegistry;
  /**
   * Whether the current session can be continued. Set by a completed turn, because that is when
   * the loop writes the snapshot a resume reads — a session that died before finishing a turn
   * has nothing to resume from, and asking would lose the next prompt to an error.
   */
  private resumable = false;
  private session: Session | null = null;
  /** The session `abort()` last aborted, so a repeat is recognised as the second abort. */
  private aborted: Session | null = null;
  /** Requests waiting behind the one on screen. */
  private readonly queue: PendingPermission[] = [];
  private readonly questions: PendingQuestion[] = [];
  private running: Promise<void> | null = null;
  private agent: Agent;
  private nextKey = 0;
  private readonly maxLines: number;

  constructor(private readonly opts: TuiControllerOptions) {
    this.permissionGrants = opts.permissionGrants ?? new PermissionGrantRegistry();
    this.maxLines = opts.maxLines ?? 5_000;
    this.agent = opts.agent;
    this.memory = opts.onMemory;
    this.dream = opts.onDream;
    this.fork = opts.onFork;
    this.undo = opts.onUndo;
    this.tree = opts.onTree;
    this.children = opts.onChildren;
    this.spawned = opts.onSpawned;
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

  setDream(fn: (auto: boolean, signal: AbortSignal) => Promise<string[]>): void {
    this.dream = fn;
  }

  setReview(fn: (args: string, signal: AbortSignal) => Promise<string[]>): void { this.review = fn; }

  /** Both manual and supervisor undo must stop automatic continuation from reverted claims. */
  forgetRestoredConversation(): void {
    this.resetGrants("conversation-restored");
    this.resumable = false;
    this.set({sessionId:null,turns:0,plan:[],signals:[],children:[],manifest:null,context:null});
    this.print("next prompt starts a fresh conversation; original history is retained", "system");
  }

  setSessions(fns: {
    fork: (parent: string, atSeq?: number) => Promise<{ id: string; atSeq: number }>;
    undo?: (id: string, toTurn?: number) => Promise<{restored:boolean;message:string}>;
    tree: (id: string) => Promise<string[]>;
    children?: (children: ReadonlyArray<TuiChild>, now: number, parent: string) => Promise<string[]>;
    spawned?: (id: string) => Promise<TuiChild[]>;
  }): void {
    this.fork = fns.fork;
    if (fns.undo !== undefined) this.undo = fns.undo;
    this.tree = fns.tree;
    if (fns.children !== undefined) this.children = fns.children;
    if (fns.spawned !== undefined) this.spawned = fns.spawned;
  }

  /** The loaded catalogue, for `/skills` and `/<skill-name>`. Set after buildAgent discovers it. */
  setSkills(skills: Skill[]): void {
    this.skills = skills;
  }
  private extensionCommands: Array<ExtensionCommand & { extension: string }> = [];
  setCommands(commands: Array<ExtensionCommand & { extension: string }>): void { this.extensionCommands = commands; }

  private memory: ((query: string) => Promise<string[]>) | undefined;
  private cost: ((session?: string) => Promise<string[]>) | undefined;
  setCost(fn: (session?: string) => Promise<string[]>): void { this.cost = fn; }
  private dream: ((auto: boolean, signal: AbortSignal) => Promise<string[]>) | undefined;
  private dreamAbort: AbortController | undefined;
  private dreaming: Promise<void> | undefined;
  private review: TuiControllerOptions["onReview"];
  private reviewAbort: AbortController | undefined;
  private reviewing: Promise<void> | undefined;
  private observer: { detach(): void; done: Promise<void> } | undefined;
  private closing = false;
  private closed = false;
  private toolSummaries = new ToolSummaries();
  private fork: ((parent: string, atSeq?: number) => Promise<{ id: string; atSeq: number }>) | undefined;
  private undo: ((id: string, toTurn?: number) => Promise<{restored:boolean;message:string}>) | undefined;
  private undoing: Promise<void> | undefined;
  private tree: ((id: string) => Promise<string[]>) | undefined;
  private children: ((children: ReadonlyArray<TuiChild>, now: number, parent: string) => Promise<string[]>) | undefined;
  private spawned: ((id: string) => Promise<TuiChild[]>) | undefined;
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
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  print(text: string, tone: TuiLine["tone"] = "system"): void {
    if (this.closed) return;
    // A side command/permission notice is also a visible boundary. Draining first preserves
    // ordering without timers; flushReads clears its state before these recursive prints.
    for (const line of this.toolSummaries.flushReads()) this.print(line.text, line.tone);
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
  readonly ask = (req: PermissionRequest, context?: PermissionAskContext, signal?: AbortSignal): Promise<Exclude<Decision, "ask">> =>
    new Promise((resolve) => {
      if (signal?.aborted) { resolve("deny"); return; }
      const registry = context === undefined ? this.permissionGrants : context.permissionGrants;
      // A standing answer for this tool: asked once, applied thereafter. Being asked to approve
      // every single write in a twenty-file task is how a permission prompt stops being read at
      // all, which is worse than not having one.
      // Crossing the sandbox boundary is a separate grant. A standing tool answer must never
      // auto-approve it, and an escalation answer must never become permission for later calls.
      const sandboxEscalation = req.origin === "sandbox-escalation" || req.origin === "mcp-definition-change" || req.origin === "external-input-expansion";
      if (registry !== undefined && registry.context.sessionId === undefined) registry.beginSession("interactive-prompt");
      const revision = registry?.revision;
      const standing = sandboxEscalation ? "ask" : registry?.decide(req) ?? "ask";
      if (standing !== "ask") {
        resolve(standing);
        return;
      }
      let settled = false;
      const cancel = () => entry.resolve("deny", false);
      const finish = (decision: "allow" | "deny") => {
        settled = true; signal?.removeEventListener("abort", cancel); resolve(decision);
        // Scope editing copies presentation state; the resolver is the stable request identity.
        if (this.state.pending?.resolve === entry.resolve) this.advanceQueue();
        else {
          const index = this.queue.indexOf(entry);
          if (index >= 0) { this.queue.splice(index, 1); this.set({ queued: this.queue.length }); }
        }
      };
      const entry: PendingPermission = {
        req,
        ...(registry === undefined ? {} : { permissionGrants: registry }),
        resolve: (d, remember, scope) => {
          if (settled) return;
          if (req.origin === "external-input-expansion" && remember === true) {
            this.print("Fresh approval requires y or n; standing answers cannot approve this boundary.", "system");
            return;
          }
          settled = true;
          if (scope !== undefined || (remember === true && !sandboxEscalation)) {
            try {
              if (registry === undefined) throw new Error("no runtime grant registry; use a one-time answer");
              if (!registry.active || revision !== registry.revision) throw new Error("permission context changed while the prompt was open");
              if (scope === undefined) registry.remember(req, d);
              else {
                if (d !== "allow") throw new Error("scoped approval must be an explicit allow");
                registry.grant(proposedPermissionGrant(req, scope.kind, scope.text, registry));
              }
            } catch (error) {
              this.print(`standing permission refused: ${String(error)}`, "error");
              finish("deny"); return;
            }
            this.print(
              `${d === "allow" ? "allowing" : "denying"} ${req.tool}${scope === undefined ? "" : " within confirmed scope"} ${registry?.isChildView ? "for this child within the current parent run" : "for the rest of this session"} (/permissions to review)`,
              d === "allow" ? "system" : "error",
            );
          } else {
            this.print(`${d === "allow" ? "allowed" : "denied"} ${req.tool}`, d === "allow" ? "system" : "error");
          }
          finish(d);
        },
      };
      // A single slot silently overwrote the first resolver when two requests overlapped,
      // leaving its promise unsettled and the loop wedged with no diagnostic. Core runs tool
      // calls sequentially today, so that is latent rather than live — but parallel tool
      // execution is an obvious near-term change, and a queue costs nothing now.
      if (this.state.pending === null) {
        this.showPermissionEffects(req);
        this.set({ pending: entry });
      }
      else {
        this.queue.push(entry);
        this.set({ queued: this.queue.length });
      }
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });

  private advanceQueue(): void {
    const next = this.queue.shift();
    if (next !== undefined) this.showPermissionEffects(next.req);
    this.set({ pending: next ?? null, queued: this.queue.length });
  }

  private showPermissionEffects(req: PermissionRequest): void {
    if (req.origin === "mcp-definition-change") this.print(JSON.stringify(req.input, null, 2), "system");
    if (req.operation !== undefined) this.print(`shell operation: ${JSON.stringify(req.operation)}`, "system");
    for (const line of permissionEffectLines(req)) this.print(line, "system");
  }

  /**
   * `remember` makes the answer standing for that tool, for this session only. Deliberately not
   * persisted: a blanket grant written to disk is a decision that outlives the task it was made
   * for, and nobody would remember making it.
   */
  answerPermission(d: Exclude<Decision, "ask">, remember = false): void {
    if (this.state.pending?.scope !== undefined) return;
    this.state.pending?.resolve(d, remember);
  }

  startPermissionScope(): void {
    const pending = this.state.pending;
    if (pending === null) return;
    try {
      if (pending.permissionGrants === undefined) throw new Error("no runtime grant registry; use a one-time answer");
      const draft = initialPermissionScope(pending.req);
      if (Buffer.byteLength(draft.text) > MAX_SCOPE_TEXT) throw new Error("initial scope exceeds 24 KiB");
      this.set({ pending: { ...pending, scope: { ...draft, preview: false } } });
    } catch (error) { this.print(`scoped approval unavailable: ${String(error).slice(0, 1000)}`, "error"); }
  }

  editPermissionScope(text: string): void {
    const pending = this.state.pending;
    if (pending?.scope === undefined) return;
    if (text.length > MAX_SCOPE_TEXT || Buffer.byteLength(text) > MAX_SCOPE_TEXT) {
      this.set({ pending: { ...pending, scope: { ...pending.scope, preview: false, error: "scope exceeds 24 KiB; input refused" } } });
      return;
    }
    this.set({ pending: { ...pending, scope: { kind: pending.scope.kind, text, preview: false } } });
  }

  previewPermissionScope(): void {
    const pending = this.state.pending;
    if (pending?.scope === undefined) return;
    try {
      if (pending.permissionGrants === undefined || !pending.permissionGrants.active) throw new Error("permission grant context unavailable or expired");
      const spec = proposedPermissionGrant(pending.req, pending.scope.kind, pending.scope.text, pending.permissionGrants);
      this.print(`Exact proposed future grant (NOT installed): ${JSON.stringify(spec)}`, "system");
      this.print(`Covers the current request. Path prefixes include descendants; argv prefixes permit trailing arguments. Cwd is exact. ${pending.permissionGrants.isChildView ? "Child-owned, expires with current parent run" : "Session-only"}; descendants inherit only delegable grants. Not OS containment or an effect guarantee. Confirm separately with y.`, "system");
      this.set({ pending: { ...pending, scope: { kind: pending.scope.kind, text: pending.scope.text, preview: true } } });
    } catch (error) {
      this.set({ pending: { ...pending, scope: { ...pending.scope, preview: false, error: `scope refused: ${String(error).slice(0, 1000)}` } } });
    }
  }

  confirmPermissionScope(): void {
    const pending = this.state.pending;
    if (pending?.scope?.preview !== true) return;
    pending.resolve("allow", false, pending.scope);
  }

  cancelPermissionScope(): void {
    const pending = this.state.pending;
    if (pending?.scope === undefined) return;
    const { scope: _scope, ...plain } = pending;
    this.set({ pending: plain });
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

  /** A distinct clarification queue: answering it never steers or grants permission. */
  readonly askQuestion: import("@agentkitai/agentrig-core").QuestionHandler = (request, signal) => {
    if (this.closed || this.closing || signal.aborted || this.questions.length >= 8) return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false;
      const entry: PendingQuestion = { request: structuredClone(request), signal, resolve: answer => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
        const index = this.questions.indexOf(entry);
        if (index >= 0) this.questions.splice(index, 1);
        this.set({ question: this.questions[0] ?? null, queuedQuestions: Math.max(0, this.questions.length - 1) });
        resolve(answer);
      } };
      const cancel = () => entry.resolve(null);
      const timer = setTimeout(cancel, 120_000); timer.unref?.();
      signal.addEventListener("abort", cancel, { once: true });
      this.questions.push(entry);
      this.set({ question: this.questions[0] ?? null, queuedQuestions: this.questions.length - 1 });
      if (signal.aborted) cancel();
    });
  };

  answerQuestion(answer: import("@agentkitai/agentrig-core").QuestionChoice, expected = this.state.question): void {
    if (this.state.pending !== null || expected === null || this.state.question !== expected) return;
    // The runtime independently validates every answer; UI validation keeps a typo editable.
    if ("option" in answer ? !Number.isInteger(answer.option) || answer.option < 0 || answer.option >= expected.request.options.length
      : answer.text.trim().length === 0 || answer.text.length > 4096) {
      this.print("Choose a listed number or enter nonblank text (at most 4096 characters).", "error"); return;
    }
    expected.resolve({ source: "human", answer });
  }

  answerQuestionText(text: string, expected = this.state.question): void {
    this.answerQuestion(/^[1-4]$/.test(text.trim()) ? { option: Number(text.trim()) - 1 } : { text }, expected);
  }

  private closeQuestions(): void { for (const entry of [...this.questions]) entry.resolve(null); }

  answerEscalation(answer: string): void {
    this.state.escalation?.resolve(answer);
  }

  /** What has a standing answer, and how to take it back. */
  private describeStanding(): string {
    const grants = this.permissionGrants.inspect();
    if (grants.length === 0) {
      return "nothing has a standing answer — every request is asked. `a` at a prompt makes one standing.";
    }
    const now = Date.now();
    const lines = grants.map(({ grant, matchedDecisions, countSaturated, auditBlocked }) =>
      `  ${grant.decision === "allow" ? "allow" : "deny "} ${JSON.stringify(grant.operation.tool)} id=${grant.id} age=${Math.max(0, Math.floor((now - grant.createdAt) / 1000))}s matched-decisions=${countSaturated ? ">=" : ""}${matchedDecisions}${auditBlocked ? " [audit blocked]" : ""}\n` +
      `    scope=${JSON.stringify({ operation: grant.operation, resource: grant.resource, constraints: grant.constraints, duration: grant.duration, subject: grant.subject, delegable: grant.delegable })}`);
    return [...lines, "Counts are matched allow/deny decisions, not executions; previews do not count. Children inherit only delegable ancestor grants; child-owned records expire with their parent run.", "/permissions revoke <exact-id> revokes one; /permissions reset clears these. Already-running tools are not cancelled."].join("\n");
  }

  private resetGrants(reason: string): number | undefined {
    try { return this.permissionGrants.clear(reason); }
    catch (error) { this.print(`permission reset failed (grants blocked): ${String(error)}`, "error"); return undefined; }
  }

  /** Settles every outstanding request as a denial — nothing may be dropped unsettled. */
  private denyAllPending(): void {
    const all = [this.state.pending, ...this.queue].filter((p): p is PendingPermission => p !== null);
    this.queue.length = 0;
    this.state = { ...this.state, pending: null, queued: 0 };
    for (const p of all) p.resolve("deny", false);
  }

  abort(): void {
    this.closeQuestions();
    if (this.reviewAbort !== undefined) {
      this.reviewAbort.abort(); this.denyAllPending(); this.print("cancelling review…", "error");
      if (this.session === null) return;
    }
    if (this.dreamAbort !== undefined) {
      this.dreamAbort.abort(); this.print("cancelling dream…", "error");
      if (this.session === null) return;
    }
    if (this.session === null) {
      this.print("nothing running", "system");
      return;
    }
    const again = this.aborted === this.session;
    this.aborted = this.session;
    this.session.control.abort();
    // a pending prompt would otherwise hold the loop open waiting for an answer nobody will give
    this.denyAllPending();
    // The first abort stops the work; session_end hooks (memory ingest, the dream trigger) still
    // run for a session aborted mid-turn (#88), and the second abort stops those. A session that
    // had already finished its turn and was in its hooks is cut by the first — the controller
    // cannot tell the two apart, so the first message promises nothing about the hooks.
    this.print(
      again ? "aborting again — skipping session_end hooks" : "aborting… (abort again to skip session_end hooks)",
      "error",
    );
  }

  /**
   * Stops anything still running and waits for it. Called when the UI closes: a session left
   * running with the terminal gone keeps executing tools and billing, unwatched.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.observer?.detach();
    if (this.session !== null || this.dreamAbort !== undefined || this.reviewAbort !== undefined) this.abort();
    // unconditionally: a request can be outstanding with no session running (the loop is blocked
    // inside onAsk), and leaving it unsettled is a promise that can never resolve
    this.denyAllPending();
    this.state.escalation?.resolve(null, "closed");
    this.closeQuestions();
    await this.running?.catch(() => {});
    await this.dreaming?.catch(() => {});
    await this.reviewing?.catch(() => {});
    await this.undoing?.catch(() => {});
    this.resetGrants("controller-closed");
    this.closed = true;
  }

  /** Handles one submitted line. Returns false when the app should exit. */
  async submit(line: string): Promise<boolean> {
    if (this.closing) return false;
    if (this.undoing) { this.print("undo is running; wait for it to finish", "error"); return true; }
    const cmd = parseCommand(line);
    if (cmd === null) return true;
    if (cmd.kind !== "task") this.print(line, "you");
    return this.run(cmd);
  }

  /** Transport prompt, deliberately not the slash-command interpreter. Joins the actual run. */
  async prompt(text: string, advisoryContext?: readonly string[]): Promise<void> {
    if (this.closing || this.state.status === "running" || this.undoing || this.dreaming) throw new Error("session is unavailable or busy");
    if (!text.trim() && !advisoryContext?.length) throw new Error("prompt is empty");
    await this.start(text, { cwd: this.opts.cwd,
      ...(this.state.sessionId !== null && this.resumable ? { resume: this.state.sessionId } : {}),
      ...(advisoryContext === undefined ? {} : { advisoryContext }) });
  }

  private async run(cmd: TuiCommand): Promise<boolean> {
    if (this.reviewAbort !== undefined && !["abort", "quit", "help", "permissions"].includes(cmd.kind)) {
      this.print("a review is running — stop it before starting other work", "error"); return true;
    }
    switch (cmd.kind) {
      case "quit":
        // stop the work before tearing the UI down, or the session runs on invisibly
        if (this.session !== null || this.reviewAbort !== undefined) {
          this.print("stopping the running turn before exiting…", "system");
          await this.shutdown();
        }
        return false;
      case "help":
        this.print(helpText(this.extensionCommands), "system");
        return true;
      case "abort":
        this.abort();
        return true;
      case "plan":
        this.print(
          this.state.plan.length === 0
            ? "no plan recorded yet — the agent writes one with update_plan"
            : this.state.plan.map((i) => `  [${i.status}] ${i.text}\n    ${renderPlanAcceptance(i.accept)}`).join("\n"),
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
      case "cost":
        await this.delegate("cost", () => this.cost?.(this.state.sessionId ?? undefined));
        return true;
      case "dream": {
        if (this.dreamAbort !== undefined) { this.print("a dream is already running", "error"); return true; }
        const controller = new AbortController(); this.dreamAbort = controller;
        this.dreaming = this.delegate("dream", () => this.dream?.(cmd.auto, controller.signal));
        try { await this.dreaming; } finally { this.dreamAbort = undefined; this.dreaming = undefined; }
        return true;
      }
      case "review": {
        if (this.session !== null || this.dreamAbort !== undefined || this.undoing !== undefined || this.state.pending !== null || this.state.question !== null || this.state.escalation !== null) {
          this.print("work or a prompt is active — stop it before /review", "error"); return true;
        }
        const controller = new AbortController(); this.reviewAbort = controller; this.set({ reviewing: true });
        this.reviewing = this.delegate("review", () => (this.review ?? this.opts.onReview)?.(cmd.args, controller.signal));
        try { await this.reviewing; } finally { this.reviewAbort = undefined; this.reviewing = undefined; this.set({ reviewing: false }); }
        return true;
      }
      case "resume":
        if (cmd.id === "") this.print("usage: /resume <session-id>", "error");
        else {
          // trust the id the user named: they are asking for a session this process never ran
          this.resumable = true;
          await this.start("Continue the task.", { resume: cmd.id });
        }
        return true;
      case "permissions":
        if (cmd.invalid) this.print("usage: /permissions [reset | revoke <exact-id>]", "error");
        else if (cmd.revoke !== undefined) {
          try {
            const revoked = this.permissionGrants.revoke(cmd.revoke, "explicit-revoke");
            this.print(revoked ? `revoked grant ${cmd.revoke}; applies to the next permission decision, not already-running tools` : `no live grant with exact id ${JSON.stringify(cmd.revoke)}`, revoked ? "system" : "error");
          } catch (error) { this.print(`permission revocation failed: ${String(error)}`, "error"); }
        } else if (cmd.reset) {
          const had = this.resetGrants("explicit-reset");
          if (had === undefined) return true;
          this.print(had === 0 ? "nothing to reset" : `cleared ${had} standing answer(s)`, "system");
        } else {
          this.print(this.describeStanding(), "system");
        }
        return true;
      case "verbose": {
        const verbose = !this.state.verbose;
        if (verbose) for (const line of this.toolSummaries.expand()) this.print(line.text, line.tone);
        else this.toolSummaries = new ToolSummaries();
        this.set({ verbose });
        this.print(
          verbose
            ? "verbose: showing the raw event trace as well as the conversation"
            : "verbose: off — compact tool summaries for future events; existing scrollback is unchanged",
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
        const extension = this.extensionCommands.find(command => command.name === cmd.name.toLowerCase());
        if (extension !== undefined) {
          if (this.state.status === "running") { this.print("a turn is already running — /abort first", "error"); return true; }
          try { await extension.run(cmd.args, Object.freeze({ print: (text: string) => this.print(String(text), "system") })); }
          catch (error) { this.print(`extension ${extension.extension}: ${String(error)}`, "error"); }
          return true;
        }
        const skill = this.skills.find((s) => s.name.toLowerCase() === cmd.name.toLowerCase());
        if (skill === undefined) {
          // same treatment as a typo'd built-in, because from the user's seat it is one.
          // Suggest only what can actually be typed back: no "?" alias, no names with spaces.
          const suggestion = suggestFor(cmd.name, [
            ...[...RESERVED_COMMAND_NAMES].filter((n) => n !== "?"),
            ...this.skills.map((s) => s.name).filter((n) => !/\s/.test(n)),
          ]);
          this.print(
            `unknown command /${cmd.name}${suggestion === null ? "" : ` — did you mean /${suggestion}?`}\n${helpText(this.extensionCommands)}`,
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
        // Topic carries merge authorization for a long train. Compaction preserves the first user
        // message, so never append authorization to history where a summary could replace it.
        if (skill.name.toLowerCase() === "topic" && this.state.sessionId !== null) {
          this.print("/topic must start a fresh conversation; run /new, then invoke /topic again", "error");
          return true;
        }
        const composed = composeSkillInvocation(skill, cmd.args, cmd.invocation);
        this.print(skill.remote ? `remote prompt "${skill.name}" requested; loading still requires its tool permissions`
          : `skill "${skill.name}" loaded into this turn (${composed.length} chars)`, "system");
        await this.continueConversation(composed);
        return true;
      }
      case "fork":
        await this.forkConversation(cmd.at);
        return true;
      case "undo": {
        if (this.state.status === "running" || this.dreaming) { this.print("work is running — stop it before /undo", "error"); return true; }
        const id = this.state.sessionId;
        if (!id || !this.undo) { this.print("no session with undo available", "error"); return true; }
        const turn = cmd.at === "" ? undefined : /^[1-9][0-9]*$/.test(cmd.at) ? Number(cmd.at) : NaN;
        if (turn !== undefined && !Number.isSafeInteger(turn)) { this.print("usage: /undo [positive turn]", "error"); return true; }
        this.undoing = (async () => {
          try {
            const result = await this.undo!(id,turn);
            this.print(result.message,"system");
            if (result.restored) {
              this.forgetRestoredConversation();
            }
          } catch (error) { this.print(`/undo failed: ${String(error)}`,"error"); }
        })();
        try { await this.undoing; } finally { this.undoing = undefined; }
        return true;
      }
      case "tree": {
        const id = this.state.sessionId;
        if (id === null) {
          this.print("no session yet — run a task first, then /tree shows where it sits", "system");
          return true;
        }
        await this.delegate("tree", () => this.tree?.(id));
        return true;
      }
      case "children": {
        if (this.state.children.length === 0) {
          this.print(
            this.state.sessionId === null
              ? "no session yet — /children shows this session's subagents once it has some"
              : "this session has spawned no subagents",
            "system",
          );
          return true;
        }
        const children = this.state.children;
        const parent = this.state.sessionId ?? "";
        // deliberately no running-turn guard: watching children while the parent works is the point
        await this.delegate("children", () => this.children?.(children, Date.now(), parent));
        return true;
      }
      case "unknown":
        this.print(`unknown command ${cmd.name === "" ? "/" : `/${cmd.name}`}\n${helpText(this.extensionCommands)}`, "error");
        return true;
      case "task":
        this.print(cmd.text, "you");
        await this.continueConversation(cmd.text);
        return true;
      case "new":
        if (this.resetGrants("new-conversation") === undefined) return true;
        this.resumable = false;
        // context is per-conversation and the next session starts empty; the model persists
        this.set({ sessionId: null, plan: [], signals: [], children: [], turns: 0, context: null });
        this.print("starting fresh — the next task begins a new session", "system");
        return true;
      default:
        return true;
    }
  }

  /**
   * `/fork [seq]`: branch the conversation into a new session and continue there (R3c). The
   * current session is never written — the child's log holds only a `session.fork` marker, and
   * the next prompt resumes the child, which materializes the inherited prefix. Refused while a
   * turn runs: the log is still being appended and "the latest event" is a moving target.
   */
  private async forkConversation(at: string): Promise<void> {
    if (this.state.status === "running") {
      this.print("a turn is already running — /abort first, then /fork", "error");
      return;
    }
    const parent = this.state.sessionId;
    if (parent === null) {
      this.print("no session to fork — run a task first", "error");
      return;
    }
    if (this.fork === undefined) {
      this.print("/fork is not available in this session", "error");
      return;
    }
    let atSeq: number | undefined;
    if (at !== "") {
      atSeq = /^\d+$/.test(at) ? Number(at) : Number.NaN;
      if (!Number.isSafeInteger(atSeq)) {
        this.print(`usage: /fork [seq] — seq is a non-negative event number in this session's log, not "${at}"`, "error");
        return;
      }
    }
    let forked: { id: string; atSeq: number };
    try {
      forked = await this.fork(parent, atSeq);
    } catch (err) {
      this.print(`/fork failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    // The child inherits the parent's conversation up to the fork point, so its plan and signals
    // are still the ones on screen; only the identity changes. Resumable even when the parent was
    // not: a fork resumes from its materialized tree, not from a snapshot.
    if (this.resetGrants("conversation-forked") === undefined) return;
    this.resumable = true;
    this.set({ sessionId: forked.id });
    this.print(
      `forked ${parent} at seq ${forked.atSeq} → ${forked.id}; this conversation continues in ${forked.id}, ${parent} is untouched`,
      "system",
    );
  }

  /** Runs an injected side command, reporting rather than throwing into the render loop. */
  private async delegate(name: string, fn: () => Promise<string[]> | undefined): Promise<void> {
    try {
      const work = fn();
      if (work === undefined) {
        this.print(`/${name} is not available in this session`, "error");
        return;
      }
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

  private async start(task: string, opts: Pick<RunOptions, "cwd" | "resume" | "advisoryContext">): Promise<void> {
    if (this.state.status === "running") {
      this.print("a turn is already running — /abort first", "error");
      return;
    }
    // Resuming a session other than the one on screen: its children are in ITS log, not in this
    // process's memory. Best effort — a log that cannot be read leaves the list empty, never stale.
    let children = this.state.children;
    if (opts.resume !== undefined && opts.resume !== this.state.sessionId) {
      children = [];
      if (this.spawned !== undefined) {
        try {
          children = await this.spawned(opts.resume);
        } catch {
          children = [];
        }
      }
    }
    let session: Session;
    try {
      session = this.agent.run(task, opts);
    } catch (err) {
      this.print(`could not start: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    this.session = session;
    try { this.permissionGrants.beginSession(session.id); }
    catch (error) {
      session.control.abort(); await session.done.catch(() => {}); this.session = null;
      this.print(`permission session refused: ${String(error)}`, "error"); return;
    }
    // before the events are consumed: an observer attached late misses the start of the session
    // it is meant to be watching
    try {
      const observer = this.opts.onSession?.(session);
      if (observer !== null && typeof observer === "object" && "detach" in observer && typeof observer.detach === "function"
        && "done" in observer && observer.done instanceof Promise) this.observer = observer as { detach(): void; done: Promise<void> };
    } catch (err) {
      this.print(`supervisor could not attach: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    // a continued session keeps the plan and the signals it already had; only a new one clears
    this.set({
      status: "running",
      activity: null,
      sessionId: session.id,
      manifest: null,
      ...(opts.resume === undefined ? { plan: [], signals: [], children: [] } : { children }),
    });

    const work = this.drive(session);
    this.running = work;
    await work;
  }

  private async drive(session: Session): Promise<void> {
    try {
      for await (const e of session.events) this.consume(e);
      for (const line of this.toolSummaries.finish()) this.print(line.text, line.tone);
      const summary = await session.done;
      this.set({ turns: summary.turns });
      this.print(
        `${summary.reason} after ${summary.turns} turn(s), ${formatUsage(summary.usage)}`,
        summary.reason === "done" ? "system" : "error",
      );
      if (summary.error !== undefined) this.print(summary.error, "error");
    } catch (err) {
      this.print(`session failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      for (const line of this.toolSummaries.finish()) this.print(line.text, line.tone);
      const observer = this.observer;
      this.observer = undefined;
      observer?.detach();
      await observer?.done.catch(() => {});
      this.session = null;
      this.running = null;
      // settle rather than drop: clearing either prompt would leave a resolver unsettled and the
      // loop or supervisor waiting on a promise that can never resolve
      this.denyAllPending();
      this.state.escalation?.resolve(null, "closed");
      this.closeQuestions();
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
    const compact = this.state.verbose ? { handled: false, lines: [] } : this.toolSummaries.push(e);
    for (const line of compact.lines) this.print(line.text, line.tone);
    for (const line of this.auxiliary.push(e)) this.print(line, "system");
    this.trackActivity(e);
    if (e.type === "plan.updated") this.set({ plan: e.items });
    if (e.type === "context.manifest") this.set({ manifest: e });
    if (e.type === "supervisor.signal") this.set({ signals: [...this.state.signals, e.signal] });
    // the parent's log is the record of which children exist; their state lives in their own logs
    if (e.type === "subagent.spawn" || e.type === "subagent.end") {
      this.set({ children: applyChildEvent(this.state.children, e) });
    }
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

    if (e.type === "message.append" && e.message.role === "assistant") {
      for (const block of e.message.content) if (block.type === "thinking") {
        this.print(this.state.verbose && block.text !== "" ? `thinking: ${block.text}` : "thinking [collapsed]", "event");
      }
    }
    if (this.state.verbose) {
      this.print(renderEvent(e), e.type === "error" ? "error" : "event");
      return;
    }
    if (compact.handled) return;
    const line = renderChatEvent(e);
    if (line !== null) this.print(line, e.type === "error" ? "error" : "event");
  }
}
