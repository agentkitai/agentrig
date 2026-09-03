/**
 * Slash-command parsing for the TUI (PLAN §5). Pure and separate from the React tree on purpose:
 * a terminal UI is nearly untestable, so everything that can be decided without a screen is
 * decided here, where a test can reach it.
 */
import { sanitizeLine } from "@agentkitai/agentrig-core";

export type TuiCommand =
  | { kind: "task"; text: string }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "abort" }
  | { kind: "memory"; query: string }
  | { kind: "dream"; auto: boolean }
  | { kind: "supervisor" }
  | { kind: "plan" }
  | { kind: "context" }
  | { kind: "verbose" }
  | { kind: "new" }
  | { kind: "permissions"; reset: boolean }
  | { kind: "resume"; id: string }
  | { kind: "skills" }
  /** `/fork [seq]` — `at` is the raw argument; the controller validates it and names the fix. */
  | { kind: "fork"; at: string }
  | { kind: "tree" }
  | { kind: "children" }
  /**
   * `/<word>` that is no built-in: an attempted skill invocation (issue #62). Resolution against
   * the loaded catalogue happens in the controller — this module stays pure — and a name that
   * matches no skill either gets the unknown-command treatment there, with a did-you-mean.
   */
  | { kind: "skill"; name: string; args: string; invocation: string }
  | { kind: "unknown"; name: string };

export interface CommandSpec {
  name: string;
  args?: string;
  summary: string;
}

/** Everything `/help` lists, and the source of truth for what `parseCommand` accepts. */
export const COMMANDS: CommandSpec[] = [
  { name: "help", summary: "show this list" },
  { name: "memory", args: "[query]", summary: "search the wiki, or list it with no query" },
  { name: "dream", args: "[--auto]", summary: "run the scheduled lint; reports unless --auto" },
  { name: "supervisor", summary: "show what the supervisor has signalled this session" },
  { name: "plan", summary: "show the agent's current plan" },
  { name: "context", summary: "show the latest prompt manifest" },
  { name: "verbose", summary: "toggle the raw event trace (off by default: you get the conversation)" },
  { name: "permissions", args: "[reset]", summary: "show the standing allow/deny answers, or clear them" },
  { name: "skills", summary: "list loaded skills; /<skill-name> [task...] runs one" },
  { name: "resume", args: "<id>", summary: "continue a previous session" },
  { name: "fork", args: "[seq]", summary: "branch this conversation into a new session; this one is left untouched" },
  { name: "tree", summary: "show this session's ancestry and forks" },
  { name: "children", summary: "live status of this session's subagents, read from their own logs" },
  { name: "new", summary: "forget this conversation and start a new session" },
  { name: "abort", summary: "stop the running turn" },
  { name: "quit", summary: "exit (bare `exit`/`quit`, and ctrl-c, also work)" },
];

/**
 * A line starting with `/` is a command; anything else is a task for the agent.
 *
 * A bare `/` or an unknown name is reported rather than sent to the model: someone who typed
 * `/memroy` meant to run a command, and silently spending a turn on it as a prompt is the
 * least useful possible response.
 */
/**
 * Bare words every REPL treats as leaving, and nobody types as a task for an agent. Typing
 * `exit` used to be sent to the model, which spent a turn and 1330 tokens replying "Exiting."
 * and then did not exit.
 */
const BARE_QUIT = new Set(["exit", "quit", "bye", ":q"]);

export function parseCommand(line: string): TuiCommand | null {
  const trimmed = line.trim();
  if (BARE_QUIT.has(trimmed.toLowerCase())) return { kind: "quit" };
  if (trimmed === "") return null;
  if (!trimmed.startsWith("/")) return { kind: "task", text: trimmed };

  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const args = rest.join(" ").trim();

  switch (name) {
    case "":
      return { kind: "unknown", name: "" };
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    case "abort":
    case "stop":
      return { kind: "abort" };
    case "memory":
      return { kind: "memory", query: args };
    case "dream":
      return { kind: "dream", auto: /(^|\s)--auto(\s|$)/.test(args) };
    case "supervisor":
      return { kind: "supervisor" };
    case "plan":
      return { kind: "plan" };
    case "context":
      return { kind: "context" };
    case "verbose":
    case "trace":
      return { kind: "verbose" };
    case "resume":
      return { kind: "resume", id: args };
    case "new":
      return { kind: "new" };
    case "permissions":
      return { kind: "permissions", reset: /(^|\s)reset(\s|$)/.test(args) };
    case "skills":
      return { kind: "skills" };
    case "fork":
      return { kind: "fork", at: args };
    case "tree":
      return { kind: "tree" };
    case "children":
      return { kind: "children" };
    default:
      // Built-ins always win: only a name NO case above claimed can reach the catalogue, so a
      // skill named "plan" can never override /plan (it is marked shadowed in /skills instead).
      return { kind: "skill", name, args, invocation: line };
  }
}

/**
 * Every name (and alias) the switch above claims. `/skills` uses it to mark shadowed skills, and
 * a test pins that each entry really parses to its built-in rather than a skill invocation —
 * without that, adding a case without updating this set would silently unmark a shadow.
 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help", "?",
  "quit", "exit",
  "abort", "stop",
  "memory",
  "dream",
  "supervisor",
  "plan",
  "context",
  "verbose", "trace",
  "resume",
  "new",
  "permissions",
  "skills",
  "fork",
  "tree",
  "children",
]);

/**
 * The user turn a `/skill-name [args...]` invocation submits (issue #62). The body is
 * repository-authored text riding in a user message — the banners label that provenance (the
 * R13d principal model: user invocation does not promote project-trust content), mirroring the
 * project-instructions banner style so one convention marks all repo-text-in-prompt seams.
 */
export function composeSkillInvocation(
  skill: { name: string; path: string; body: string },
  args: string,
  invocation?: string,
): string {
  // The name is already sanitized at parse; the path is not, and a filename may legally contain a
  // newline. Topic treats the human-invocation banner as authorization evidence, so repository text
  // must not be able to forge either that banner or the surrounding skill boundary.
  const path = sanitizeLine(skill.path, 200);
  // Leading blanks are allowed on the forged line (a model reads an indented banner as a banner);
  // the trailing class is blanks only, so the match never swallows the following line break.
  const body = skill.body.replace(
    /^[ \t]*=====.*SKILL.*=====[ \t]*$/gim,
    "[repository-authored provenance delimiter removed]",
  );
  return [
    `Follow the ${JSON.stringify(skill.name)} skill for this task.`,
    "",
    `===== BEGIN SKILL ${JSON.stringify(skill.name)} (${path}) — repository-authored instructions =====`,
    body,
    `===== END SKILL ${JSON.stringify(skill.name)} =====`,
    "",
    ...(invocation === undefined
      ? []
      : ["===== BEGIN HUMAN SKILL INVOCATION (verbatim) =====", invocation,
          "===== END HUMAN SKILL INVOCATION =====", ""]),
    args === "" ? "Proceed as the skill directs." : `Task: ${args}`,
  ].join("\n");
}

/**
 * Closest candidate within a small edit distance, for the unknown-command did-you-mean. Returns
 * null rather than guessing wildly: a suggestion that is far off is worse than none.
 */
export function suggestFor(name: string, candidates: Iterable<string>): string | null {
  const target = name.toLowerCase();
  let best: string | null = null;
  let bestCost = 3; // suggestions stop at distance 2 — beyond that it's noise
  for (const candidate of candidates) {
    const cost = editDistance(target, candidate.toLowerCase(), bestCost);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }
  return best;
}

/** Bounded Levenshtein: gives up (returns `limit`) once a row's minimum reaches the limit. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) >= limit) return limit;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin >= limit) return limit;
    prev = row;
  }
  return Math.min(prev[b.length]!, limit);
}

/** Rendered by `/help`, and on an unknown command so the answer is always in reach. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => `/${c.name} ${c.args ?? ""}`.trim().length));
  return COMMANDS.map((c) => `  ${`/${c.name} ${c.args ?? ""}`.trim().padEnd(width)}  ${c.summary}`).join("\n");
}
