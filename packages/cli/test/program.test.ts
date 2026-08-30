import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram, describeStray } from "../src/program.ts";

/**
 * The argv contract. This file exists because a root-level option regression shipped without a
 * single test failing: options added to the root `program` are consumed by Commander wherever
 * they appear in argv — including after a subcommand name — so every subcommand silently lost
 * `--root`, `--model`, `--max-turns` and the rest, falling back to its default with no error.
 *
 * Nothing could catch it because nothing could parse argv without also running the CLI.
 */

interface Captured {
  path: string;
  args: unknown[];
  opts: Record<string, unknown>;
}

/** Replaces every action in the tree with a recorder, so parsing runs but nothing executes. */
function stub(program: Command): { run: (argv: string[]) => Promise<Captured | null>; errors: string[] } {
  const errors: string[] = [];
  let captured: Captured | null = null;

  const walk = (cmd: Command, path: string[]): void => {
    const here = [...path, cmd.name()];
    cmd.action(function (this: Command, ...args: unknown[]) {
      captured = { path: here.join(" "), args: args.slice(0, -2), opts: this.opts() };
    });
    for (const sub of cmd.commands) walk(sub, here);
  };
  for (const sub of program.commands) walk(sub, []);

  program.exitOverride((err) => {
    errors.push(err.message);
    throw err;
  });
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

  return {
    run: async (argv) => {
      captured = null;
      await program.parseAsync(argv, { from: "user" }).catch(() => {});
      return captured;
    },
    errors,
  };
}

describe("argv parsing", () => {
  it("a subcommand's own options are not swallowed by the root", async () => {
    const { run } = stub(buildProgram());
    // each of these was silently lost when the TUI's options lived on the root program
    expect((await run(["sessions", "ls", "--root", "foo"]))?.opts.root).toBe("foo");
    expect((await run(["run", "x", "--root", "bar"]))?.opts.root).toBe("bar");
    expect((await run(["run", "x", "--provider", "openai"]))?.opts.provider).toBe("openai");
    expect((await run(["run", "x", "--model", "gpt-5"]))?.opts.model).toBe("gpt-5");
    expect((await run(["run", "x", "--max-turns", "3"]))?.opts.maxTurns).toBe("3");
    expect((await run(["run", "x", "--max-tokens-per-turn", "99"]))?.opts.maxTokensPerTurn).toBe("99");
    expect((await run(["run", "x", "--base-url", "http://h/v1"]))?.opts.baseUrl).toBe("http://h/v1");
    expect((await run(["dream", "--model", "m"]))?.opts.model).toBe("m");
    expect((await run(["memory", "ingest", "s1", "--model", "m"]))?.opts.model).toBe("m");
    expect((await run(["sessions", "resume", "s1", "--max-turns", "7"]))?.opts.maxTurns).toBe("7");
  });

  it("carries the skip-permissions flags on every entry point that runs an agent", async () => {
    const { run } = stub(buildProgram());
    // A flag the parser accepts and the wiring drops is the shape `--supervise` had in the TUI
    // for weeks: validated, documented, and doing nothing. `skip-permissions.test.ts` pins what
    // the policy does with these; this pins that they arrive at all.
    expect((await run(["run", "x", "--yolo"]))?.opts.yolo).toBe(true);
    expect((await run(["run", "x", "--dangerously-skip-permissions"]))?.opts.dangerouslySkipPermissions).toBe(true);
    expect((await run(["--yolo"]))?.opts.yolo).toBe(true);
    expect((await run(["sessions", "resume", "s1", "--yolo"]))?.opts.yolo).toBe(true);
    // and neither is on unless it was asked for — from a FRESH program, because commander keeps
    // parsed option values on the command object and a reused one carries the earlier --yolo over
    const fresh = stub(buildProgram());
    expect((await fresh.run(["run", "x"]))?.opts.yolo).toBeUndefined();
    expect((await fresh.run(["run", "x"]))?.opts.dangerouslySkipPermissions).toBeUndefined();
  });

  it("dispatches to the command that was named", async () => {
    const { run } = stub(buildProgram());
    expect((await run(["sessions", "ls"]))?.path).toBe("sessions ls");
    expect((await run(["memory", "lint"]))?.path).toBe("memory lint");
    expect((await run(["dream"]))?.path).toBe("dream");
    expect((await run(["run", "do it"]))?.path).toBe("run");
    expect((await run(["login", "openai-chatgpt"]))?.path).toBe("login");
  });

  it("passes positional arguments through", async () => {
    const { run } = stub(buildProgram());
    expect((await run(["run", "fix the bug"]))?.args[0]).toBe("fix the bug");
    expect((await run(["sessions", "show", "abc"]))?.args[0]).toBe("abc");
    expect((await run(["memory", "search", "retry", "policy"]))?.args[0]).toEqual(["retry", "policy"]);
  });

  it("bare agentrig reaches the TUI", async () => {
    const { run } = stub(buildProgram());
    expect((await run([]))?.path).toBe("tui");
  });

  it("an unknown subcommand is rejected, not treated as a bare TUI launch", () => {
    // `isDefault` catches any unmatched argv, so without this `agentrig sessons ls` dropped the
    // user into an interactive agent with their intended command discarded
    const known = ["run", "dream", "sessions", "memory", "login"];
    expect(describeStray(["sessons", "ls"], known)).toMatch(/unknown command 'sessons'/);
    expect(describeStray(["sessons"], known)).toMatch(/Did you mean sessions\?/);
    expect(describeStray(["memroy"], known)).toMatch(/Did you mean memory\?/);
  });

  it("a bare launch is not mistaken for a typo", () => {
    // Commander strips consumed option values before this sees them, so `agentrig --model gpt`
    // arrives as `[]` — verified against commander@12 rather than assumed
    const known = ["run", "dream"];
    expect(describeStray([], known)).toBeNull();
    // defensive: a bare flag that somehow survived is still not an operand
    expect(describeStray(["--model"], known)).toBeNull();
  });

  it("offers no suggestion when nothing is close, rather than a misleading one", () => {
    expect(describeStray(["zzzzzzzz"], ["run", "dream"])).toBe("error: unknown command 'zzzzzzzz'");
  });

  it("parses repeatable drift scopes and contracts for run and the default TUI", async () => {
    const { run } = stub(buildProgram());
    expect((await run(["run", "x", "--drift-scope", "src", "--drift-scope", "test"]))?.opts.driftScope).toEqual([
      "src",
      "test",
    ]);
    expect((await run(["--drift-scope", "packages/cli"]))?.opts.driftScope).toEqual(["packages/cli"]);
    expect(
      (await run(["run", "x", "--drift-contract", "package.json", "--drift-contract", ".github"]))?.opts
        .driftContract,
    ).toEqual(["package.json", ".github"]);
    expect((await run(["--drift-contract", "custom.config.ts"]))?.opts.driftContract).toEqual(["custom.config.ts"]);
  });

  it("keeps flags of the same name distinct per subcommand", async () => {
    const { run } = stub(buildProgram());
    // `dream` has --scope; run/TUI deliberately use --drift-scope. Neither should leak.
    expect((await run(["dream", "--scope", "global"]))?.opts.scope).toBe("global");
    expect((await run(["run", "x"]))?.opts.scope).toBeUndefined();
    expect((await run(["run", "x", "--drift-scope", "src"]))?.opts.driftScope).toEqual(["src"]);
  });

  it("every command in the tree has an action, so none can silently no-op", () => {
    const program = buildProgram();
    const missing: string[] = [];
    const walk = (cmd: Command, path: string[]): void => {
      const here = [...path, cmd.name()];
      // a command with children is a namespace; a leaf must do something
      if (cmd.commands.length === 0 && (cmd as unknown as { _actionHandler?: unknown })._actionHandler === undefined) {
        missing.push(here.join(" "));
      }
      for (const sub of cmd.commands) walk(sub, here);
    };
    for (const sub of program.commands) walk(sub, []);
    expect(missing).toEqual([]);
  });
});

describe("--drift-contract's default is load-bearing", () => {
  it("is undefined when absent, so the detector's own watchlist survives", async () => {
    const { run } = stub(buildProgram());
    // `[]` here would reach the detector as "watch nothing" and disable the feature silently;
    // `undefined` means "no opinion", which is what lets DEFAULT_CONTRACT apply
    expect((await run(["run", "x"]))?.opts.driftContract).toBeUndefined();
    expect((await run([]))?.opts.driftContract).toBeUndefined();
    // ...while --drift-scope keeps its empty-array default, which the detector reads as "no scope"
    expect((await run(["run", "x"]))?.opts.driftScope).toEqual([]);
  });
});
