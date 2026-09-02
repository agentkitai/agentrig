import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { buildProgram, describeStray } from "../src/program.ts";
import { supervisorOptions, type SupervisorFlags } from "../src/run.ts";

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

  it("carries sandbox modes on every entry point that runs an agent", async () => {
    const { run } = stub(buildProgram());
    expect((await run(["run", "x", "--sandbox", "workspace-write"]))?.opts.sandbox).toBe("workspace-write");
    expect((await run(["--sandbox", "read-only"]))?.opts.sandbox).toBe("read-only");
    expect((await run(["sessions", "resume", "s1", "--sandbox", "none"]))?.opts.sandbox).toBe("none");
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

  it("carries abort opt-in and compatibility flags into supervisor capabilities on run and TUI", async () => {
    const capabilities = (opts: Record<string, unknown>) =>
      supervisorOptions({
        opts: opts as SupervisorFlags,
        task: "t",
        budget: {},
        memoryIndex: "",
        provider: { id: "fake", model: "m" } as never,
        soft: 0.8,
        turnsRemaining: 15,
      }).capabilities;

    for (const argv of [["run", "x"], []]) {
      const plain = await stub(buildProgram()).run(argv);
      expect(capabilities(plain!.opts)).toEqual({ abort: false });

      const enabled = await stub(buildProgram()).run([...argv, "--supervisor-abort"]);
      expect(capabilities(enabled!.opts)).toEqual({ abort: true });

      const compatible = await stub(buildProgram()).run([...argv, "--supervisor-no-abort"]);
      expect(capabilities(compatible!.opts)).toEqual({ abort: false });
    }
  });

  it("documents --supervisor-no-abort as a compatibility no-op on run and TUI", () => {
    const program = buildProgram();
    for (const name of ["run", "tui"]) {
      const command = program.commands.find((c) => c.name() === name)!;
      expect(command.options.find((o) => o.long === "--supervisor-no-abort")!.description).toMatch(/compatibility no-op/i);
    }
  });

  it("documents the abort opt-in in the public README", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("`--supervisor-abort` opts into its final abort rung");
    expect(readme).toContain("`--supervisor-no-abort` remains a compatibility no-op");
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

  it("a leading --profile no longer hijacks subcommand dispatch (issue #56)", async () => {
    // the alias shape: `alias rigp='agentrig --profile personal'` + any subcommand used to die
    // with "unknown command 'sessions' (Did you mean sessions?)" because argv fell through to
    // the default TUI command with the subcommand words as stray operands
    const { run } = stub(buildProgram());
    expect((await run(["--profile", "p", "sessions", "ls"]))?.path).toBe("sessions ls");
    expect((await run(["--profile", "p", "run", "x"]))?.path).toBe("run");
    expect((await run(["--profile", "p", "doctor"]))?.path).toBe("doctor");
    expect((await run(["--profile", "p"]))?.path).toBe("tui");
  });

  it("the --profile value survives both positions where config reads it", async () => {
    // The root option is scanned out of argv wherever it appears, so the leaf's own opts may not
    // carry it; the config seam reads optsWithGlobals, so THAT is the contract to pin.
    const capture = async (argv: string[]): Promise<string | undefined> => {
      const program = buildProgram();
      let merged: string | undefined;
      program.commands.find((c) => c.name() === "run")!.action(function (this: Command) {
        merged = (this.optsWithGlobals() as { profile?: string }).profile;
      });
      program.exitOverride((err) => { throw err; });
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      await program.parseAsync(argv, { from: "user" }).catch(() => {});
      return merged;
    };
    expect(await capture(["run", "x", "--profile", "trailing"])).toBe("trailing");
    expect(await capture(["--profile", "leading", "run", "x"])).toBe("leading");
  });

  it("says --profile is ignored on commands that never consult config, instead of silence", async () => {
    // an alias appends --profile to EVERY forwarded subcommand, so these paths are hit
    // constantly; accepted-but-silently-dead is the timeoutMs failure mode all over again
    const notes: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void notes.push(a.join(" ")));
    // a fresh program per parse: commander keeps parsed option values on the command object,
    // so a reused tree would leak the earlier --profile into the silent cases below
    const parse = async (argv: string[]) => stub(buildProgram()).run(argv);
    try {
      await parse(["--profile", "p", "memory", "ls"]);
      await parse(["dream", "--profile", "p", "--structural-only"]);
      expect(notes.filter((n) => n.includes("--profile is ignored by `ls`"))).toHaveLength(1);
      expect(notes.filter((n) => n.includes("--profile is ignored by `dream`"))).toHaveLength(1);
      notes.length = 0;
      await parse(["--profile", "p", "run", "x"]);
      await parse(["--profile", "p"]);
      await parse(["memory", "ls"]);
      expect(notes.filter((n) => n.includes("--profile is ignored"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("dual registration is confined to --profile — no other flag moved to the root", () => {
    // Every root option is scanned out of argv anywhere it appears, swallowing the same flag
    // from subcommands (the shipped regression this file exists for). --profile accepts that
    // deliberately, with optsWithGlobals recovery; anything else appearing here is a regression.
    const rootFlags = buildProgram().options.map((o) => o.long);
    expect(rootFlags).toEqual(["--profile"]);
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
