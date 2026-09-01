import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverSkills,
  RulePolicy,
  defaultRules,
  type AgentBuildOptions,
  type ModelProvider,
  type PermissionRequest,
  type Skill,
} from "@agentkitai/agentrig-core";
import { subagentOptions, type AgentExtras } from "../src/agent-builder.ts";
import { buildProgram } from "../src/program.ts";

/**
 * The CLI's subagent wiring had no tests at all, and everything that makes a subagent safe or
 * useful lives in it: what a child may spend, what it may do, and who answers when it asks.
 */
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-subwire-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const provider: ModelProvider = {
  id: "fake",
  model: "fake-1",
  capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 1000 },
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error("not called");
  },
};

function wiring(
  over: Partial<Parameters<typeof subagentOptions>[0]> = {},
  extras: AgentExtras = {},
): ReturnType<typeof subagentOptions> {
  return subagentOptions({
    opts: { root, maxTurns: "10", maxTokensPerTurn: "1024", provider: "anthropic", model: "m" } as AgentBuildOptions,
    extras,
    budget: { maxTurns: 10 },
    provider,
    permissionPolicy: new RulePolicy(defaultRules),
    skills: [],
    maxTokensPerTurn: 1024,
    childTools: () => [],
    ...over,
  });
}

describe("what a child may spend", () => {
  it("gives the child the parent's non-turn allowances and pools them across children", () => {
    const o = wiring({ budget: { maxTurns: 40, maxTokens: 500_000, maxUsd: 5, maxMinutes: 30 } });
    // the parent's own meter never sees a child's tokens, so the bound has to be stated — and
    // each child gets a SHARE, so eight of them add up to the parent's budget rather than eight
    // times it
    expect(o.childBudget).toEqual({ maxTokens: 500_000 / 8, maxUsd: 5 / 8, maxMinutes: 30 });
    expect(o.maxChildTokens).toBe(500_000);
    expect(o.maxChildUsd).toBe(5);
    expect(o.maxChildren).toBe(8);
  });

  it("passes pricing through, or maxUsd binds nothing", () => {
    const pricing = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    expect(wiring({ pricing }).pricing).toEqual(pricing);
  });

  it("honours --subagent-max-turns and --subagent-max-children", () => {
    const o = wiring({
      opts: {
        root,
        maxTurns: "10",
        maxTokensPerTurn: "1024",
        provider: "anthropic",
        model: "m",
        subagentMaxTurns: "3",
        subagentMaxChildren: "2",
      } as AgentBuildOptions,
    });
    expect(o.maxTurns).toBe(3);
    expect(o.maxChildren).toBe(2);
  });

  it("rejects a non-numeric flag by its own name rather than defaulting", () => {
    expect(() =>
      wiring({
        opts: { root, maxTurns: "10", maxTokensPerTurn: "1024", subagentMaxTurns: "lots" } as AgentBuildOptions,
      }),
    ).toThrow(/--subagent-max-turns/);
  });
});

describe("what a child inherits", () => {
  it("never a subagent tool: the depth limit is the core tool's to enforce", () => {
    const config = wiring({ childTools: () => [] }).childConfig();
    expect(config.tools.map((t) => t.name)).not.toContain("subagent");
  });

  it("the same permission policy object — a child that could do more would be a bypass", () => {
    const permissionPolicy = new RulePolicy(defaultRules);
    expect(wiring({ permissionPolicy }).childConfig().permissions).toBe(permissionPolicy);
  });

  it("the parent's asker, so an interactive parent's child is not silently deny-only", async () => {
    const asked: PermissionRequest[] = [];
    const o = wiring({}, {
      onAsk: async (req) => {
        asked.push(req);
        return "allow";
      },
    });
    const config = o.childConfig();
    expect(config.onAsk).toBeDefined();
    // AgentConfig.onAsk defaults to DENY: without this the TUI's subagent could not write a file,
    // was never prompted about it, and had no way to say so
    expect(await config.onAsk!({ tool: "write_file", input: {}, class: "write", cwd: "/w" })).toBe("allow");
    expect(asked).toHaveLength(1);
    // and the ask is tagged on the CONFIG, so the emitted event carries it as well as the prompt
    expect(config.origin).toBe("subagent");
  });

  it("no asker at all when the parent has none, rather than a prompt nobody is watching", () => {
    expect(wiring().childConfig().onAsk).toBeUndefined();
  });

  it("the project's skills, catalogue and tool both", async () => {
    await writeFile(join(root, "deploy.md"), "---\ndescription: how to ship\n---\nRUN THE RELEASE SCRIPT", "utf8");
    const skills: Skill[] = await discoverSkills({ roots: [root] });
    const config = wiring({ skills }).childConfig();

    expect(config.tools.map((t) => t.name)).toContain("skill");
    const prompt = typeof config.systemPrompt === "function" ? config.systemPrompt({ task: "t", cwd: "/w" }) : "";
    expect(prompt).toContain("- deploy: how to ship");
    // ...and the body is still not in the prompt
    expect(prompt).not.toContain("RUN THE RELEASE SCRIPT");
  });

  it("no skill tool when there are none, rather than an empty catalogue in every request", () => {
    const config = wiring({ skills: [] }).childConfig();
    expect(config.tools.map((t) => t.name)).not.toContain("skill");
    const prompt = typeof config.systemPrompt === "function" ? config.systemPrompt({ task: "t", cwd: "/w" }) : "";
    expect(prompt).not.toContain("## Skills");
  });

  it("a fresh store per child, the parent's per-turn cap, and its repo-map opt-out", () => {
    const o = wiring({
      maxTokensPerTurn: 4096,
      opts: {
        root,
        maxTurns: "10",
        maxTokensPerTurn: "1024",
        provider: "anthropic",
        model: "m",
        repoMap: false,
      } as AgentBuildOptions,
    });
    const first = o.childConfig();
    const second = o.childConfig();
    expect(first.store.root).toBe(root);
    // a store carries per-session seq state, so children must not share one instance
    expect(first.store).not.toBe(second.store);
    expect(first.maxTokensPerTurn).toBe(4096);
    expect(first.repoMap).toBe(false);
  });
});

describe("--shell", () => {
  it("is offered by every command that builds an agent", () => {
    const program = buildProgram();
    for (const name of ["run", "tui"]) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      expect(cmd.options.map((o) => o.long)).toContain("--shell");
    }
  });
});

describe("the flags exist on the commands that build an agent", () => {
  it("run and tui both accept --subagents, --skills and the subagent bounds", async () => {
    await mkdir(join(root, "skills"), { recursive: true });
    const program = buildProgram();
    for (const name of ["run", "tui"]) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      const flags = cmd.options.map((o) => o.long);
      expect(flags).toContain("--subagents");
      expect(flags).toContain("--subagent-max-turns");
      expect(flags).toContain("--subagent-max-children");
      expect(flags).toContain("--skills");
      expect(flags).toContain("--repo-map");
      expect(flags).toContain("--no-repo-map");
    }
  });

  it("--skills is repeatable, so a project dir can shadow a global one", () => {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === "run")!;
    run.parseOptions(["--skills", "/a", "--skills", "/b"]);
    expect(run.opts()["skills"]).toEqual(["/a", "/b"]);
  });
});
