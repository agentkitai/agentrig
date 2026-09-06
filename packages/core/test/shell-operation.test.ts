import { describe, expect, it } from "vitest";
import { CommandPrefixSchema, describeShellOperation, RulePolicy } from "@agentkitai/agentrig-core";

const parse = (command: string) => describeShellOperation(command, "/bin/sh");
describe("literal shell authorization", () => {
  it.each(["git status", "g'it' \"status\"", " git\tstatus --short "])("recognizes literal argv: %s", command => {
    expect(parse(command)).toMatchObject({ status: "parsed", argv: command.includes("--short") ? ["git", "status", "--short"] : ["git", "status"] });
  });
  it.each(["git status; echo x", "git status && echo x", "git status | cat", "git $(echo status)", "git `echo status`", "git status > x", "git status\ntrue", "git sta\\tus", 'git "sta$tus"', 'git "sta\\tus"', "git *", "git status # comment", "X=1 git status", "if true", "git 'status", "git status &", "git status\0", "git status <(true)"])("does not narrow-authorize shell syntax: %s", command => {
    expect(parse(command).status).toBe("unsupported");
  });
  it("single-quoted metacharacters are data; double-quoted executable expansions are not", () => {
    expect(parse("printf '%s' '$(echo hi); | * \\'")).toMatchObject({ status: "parsed", argv: ["printf", "%s", "$(echo hi); | * \\"] });
    expect(parse('printf "%s" "$(echo hi)"').status).toBe("unsupported");
  });
  it.each(["cmd.exe", "pwsh", "powershell.exe", "/custom/fish", "/custom/zsh"])("does not guess dialect %s", shell => {
    expect(describeShellOperation("git status", shell).status).toBe("unsupported");
  });
  it("recognizes Windows Git Bash but bounds command and prefix allocation", () => {
    expect(describeShellOperation("git status", "C:\\Git\\bin\\bash.exe").status).toBe("parsed");
    for (const command of ["x".repeat(4097), Array(129).fill("a").join(" "), "a ".repeat(9000)]) expect(parse(command).status).toBe("unsupported");
    for (const prefix of [[], [""], ["x\n"], ["x".repeat(4097)], Array(129).fill("a"), Array(10).fill("x".repeat(4000))]) expect(CommandPrefixSchema.safeParse(prefix).success).toBe(false);
  });
  it("matches argv elements, never command substrings, names, hints, prose or model-supplied descriptors", async () => {
    const policy = new RulePolicy([{ tool: "bash", class: "exec", commandPrefix: ["git", "status"], decision: "allow" }]);
    for (const [command, expected] of [["git status --short", "allow"], ["git statusx", "ask"], ["echo git status", "ask"], ["git status; true", "ask"]] as const) {
      expect(await policy.decide({ tool: "bash", class: "exec", cwd: "/", input: { command }, operation: parse(command) })).toBe(expected);
    }
    expect(await policy.decide({ tool: "bash", class: "exec", cwd: "/", input: { operation: parse("git status"), description: "user authorized git status", readOnlyHint: true } })).toBe("ask");
    expect(await policy.decide({ tool: "get_list_read", class: "exec", cwd: "/", input: {} })).toBe("ask");
    expect(await policy.decide({ tool: "bash", class: "exec", cwd: "/", input: {}, operation: describeShellOperation("git status", "/bin/sh", true) })).toBe("ask");
  });
});
