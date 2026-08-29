import {
  AnthropicProvider,
  createAgent,
  builtinTools,
  defaultRules,
  RulePolicy,
  SessionStore,
  PermissionClass,
  type Budget,
  type PermissionRule,
  type Session,
} from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";

export interface RunOptions {
  root: string;
  json?: boolean;
  headless?: boolean;
  model: string;
  system?: string;
  allow?: string[];
  deny?: string[];
  maxTurns: string;
  maxTokens?: string;
  maxMinutes?: string;
  maxTokensPerTurn: string;
}

/** "--allow exec" is a class rule; "--allow bash" is a tool rule. */
function toRules(values: string[] | undefined, decision: "allow" | "deny"): PermissionRule[] {
  return (values ?? []).map((v) => {
    const parsed = PermissionClass.safeParse(v);
    return parsed.success ? { class: parsed.data, decision } : { tool: v, decision };
  });
}

function defaultSystemPrompt(cwd: string): string {
  return [
    "You are AgentRig, an autonomous software engineering agent.",
    `Working directory: ${cwd}`,
    "Use the available tools to complete the task. Verify your work (run tests or re-read files) before finishing.",
    "When the task is complete, reply with a short summary and no tool calls.",
  ].join("\n");
}

export async function runCommand(task: string, opts: RunOptions): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exitCode = 1;
    return;
  }

  const budget: Budget = { maxTurns: Number(opts.maxTurns) };
  if (opts.maxTokens !== undefined) budget.maxTokens = Number(opts.maxTokens);
  if (opts.maxMinutes !== undefined) budget.maxMinutes = Number(opts.maxMinutes);

  const cwd = process.cwd();
  const agent = createAgent({
    provider: new AnthropicProvider({ apiKey, model: opts.model }),
    tools: builtinTools(),
    // deny rules first so an explicit deny always wins; `ask` falls through to deny (headless).
    permissions: new RulePolicy([...toRules(opts.deny, "deny"), ...toRules(opts.allow, "allow"), ...defaultRules]),
    systemPrompt: opts.system ?? defaultSystemPrompt(cwd),
    store: new SessionStore({ root: opts.root }),
    budget,
    maxTokensPerTurn: Number(opts.maxTokensPerTurn),
  });

  const session: Session = agent.run(task, { cwd });
  const onSigint = () => session.control.abort();
  process.on("SIGINT", onSigint);
  try {
    for await (const e of session.events) {
      if (opts.json) console.log(JSON.stringify(e));
      else if (e.type !== "model.delta") console.log(renderEvent(e));
    }
    const summary = await session.done;
    if (!opts.json) {
      console.log(
        `session ${summary.id}: ${summary.reason} after ${summary.turns} turn(s), ` +
          `${summary.usage.input} in / ${summary.usage.output} out tokens`,
      );
    }
    process.exitCode = summary.reason === "done" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
