/**
 * Slash-command parsing for the TUI (PLAN §5). Pure and separate from the React tree on purpose:
 * a terminal UI is nearly untestable, so everything that can be decided without a screen is
 * decided here, where a test can reach it.
 */

export type TuiCommand =
  | { kind: "task"; text: string }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "abort" }
  | { kind: "memory"; query: string }
  | { kind: "dream"; auto: boolean }
  | { kind: "supervisor" }
  | { kind: "plan" }
  | { kind: "verbose" }
  | { kind: "new" }
  | { kind: "resume"; id: string }
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
  { name: "verbose", summary: "toggle the raw event trace (off by default: you get the conversation)" },
  { name: "resume", args: "<id>", summary: "continue a previous session" },
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
    case "verbose":
    case "trace":
      return { kind: "verbose" };
    case "resume":
      return { kind: "resume", id: args };
    case "new":
      return { kind: "new" };
    default:
      return { kind: "unknown", name };
  }
}

/** Rendered by `/help`, and on an unknown command so the answer is always in reach. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => `/${c.name} ${c.args ?? ""}`.trim().length));
  return COMMANDS.map((c) => `  ${`/${c.name} ${c.args ?? ""}`.trim().padEnd(width)}  ${c.summary}`).join("\n");
}
