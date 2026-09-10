import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PermissionGrantRegistry, describeShellOperation, type ModelProvider, type PermissionRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
import { evaluationTransport, type EvaluationTransport } from "../src/evaluation-transport.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const image = `sha256:${"1".repeat(64)}`;
const bundle = fileURLToPath(new URL("../../../eval/fixtures/is-number-pinned.bundle", import.meta.url));
const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const check = fileURLToPath(new URL("../../../eval/check.mjs", import.meta.url));

const runner = await import(new URL("../../../eval/r17f.mjs", import.meta.url).href) as {
  Settings: { parse(value: unknown): unknown };
  R17F_TOTAL_TOKENS: number; HANG_GUARD_MS: number; REQUEST_TIMEOUT_MS: number;
  measuredProfile(cwd: string, home: string, load?: unknown): Promise<Record<string, unknown>>;
  armProfile(profile: object, arm: string): { profile: Record<string, unknown>; overrides: Record<string, unknown> };
  bounded(provider: ModelProvider, timeoutMs?: number): ModelProvider;
  presetApprovals(controller: TuiController, grants: PermissionGrantRegistry, signal?: AbortSignal): {
    prompts: Array<Record<string, unknown>>;
    ask(req: PermissionRequest, context?: unknown): Promise<"allow" | "deny">;
  };
  transcriber(): { lines: string[]; push(event: unknown): void };
  attemptKey(ordinal: number, config: object): string;
  measurementSignals(controller: AbortController, source: EventEmitter): () => void;
  run(settings: object, dependencies?: object): Promise<{ completed: unknown[]; blocked: string | null; tokens: number }>;
};
const corpusModule = await import(new URL("../../../eval/r17f-corpus.mjs", import.meta.url).href) as {
  E3_CORPUS_SHA256: string; E3_ARCHIVE: string;
  frozenCorpusCopies(bundle: { files: Record<string, { sha256: string; base64: string }> }): { attempts: number };
  extractFrozenCorpus(destination: string, archive?: string): Promise<{ sha256: string; files: number; source: { attempts: number } }>;
};
const support = await import(new URL("../../../eval/live-support.mjs", import.meta.url).href) as {
  schedule(): Array<{ task: string; repeat: number; position: number; supervisor: boolean; memory: boolean }>;
};
const summary = await import(new URL("../../../eval/summarize-live.mjs", import.meta.url).href) as {
  summarize(results: unknown): { groups: Array<{ supervisor: boolean; memory: boolean; completed: number; notRun: number }> };
};
const { fix } = await import(new URL("../../../eval/scripted-fixtures.mjs", import.meta.url).href) as { fix: string };

async function temp(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Real E1 preparation and the real independent checker, run locally over a trusted fixture.
 * This is a mechanics fixture, not a claim of Docker isolation: production runs use pinned images. */
function fixtureTransport(): EvaluationTransport {
  const base = evaluationTransport();
  return { ...base, preflight: async () => {},
    async command(program, args, options) {
      // The frozen-evaluator identity check must not read this worktree's live state in a test.
      if (program === "git" && options?.cwd === repo && args[0] === "rev-parse")
        return { code: 0, infrastructure: false, stdout: `${"a".repeat(40)}\n`, stderr: "", error: null };
      if (program === "git" && options?.cwd === repo && args[0] === "status")
        return { code: 0, infrastructure: false, stdout: "", stderr: "", error: null };
      return base.command(program, args, options);
    },
    async worker(options, args, signal, timeout) {
      if (options.checkerReceipt !== undefined) {
        const receipt = JSON.parse(await readFile(options.checkerReceipt, "utf8")) as Record<string, unknown>;
        const local = `${options.checkerReceipt}.fixture.json`;
        await writeFile(local, JSON.stringify({ ...receipt, workspace: options.workspace }), { flag: "wx" });
        return base.command(process.execPath, [check, local], { signal, timeout });
      }
      if (args[0] === "/bin/sh") return base.command("/bin/sh", ["-c", args[2]!], { cwd: options.workspace, signal, timeout });
      return base.command(args[0]!, args.slice(1), { cwd: options.workspace, signal, timeout });
    } };
}

/** Two identical literal shell inspections (the scoped-grant path), then the repair. */
function scripted(usage = true): ModelProvider {
  const commands = ["git status --short", "git status --short", `node -e ${JSON.stringify(fix)}`];
  let call = 0;
  return { id: "scripted-fixture", model: "mechanics-only",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      const command = commands[call++];
      if (command === undefined) yield { type: "text_delta", text: "Completed." };
      else yield { type: "tool_use", id: `call-${call}`, name: "bash", input: { command } };
      if (usage) yield { type: "usage", usage: { input: 10, output: 5 } };
      yield { type: "stop", reason: command === undefined ? "end_turn" : "tool_use" };
    } };
}

/** Enough identical foreground turns to cross the default budget wrap-up window. */
function idling(turns: number): ModelProvider {
  let call = 0;
  return { id: "scripted-fixture", model: "mechanics-only",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      const more = call++ < turns;
      if (more) yield { type: "tool_use", id: `call-${call}`, name: "bash", input: { command: "git status --short" } };
      else yield { type: "text_delta", text: "Stopping." };
      yield { type: "usage", usage: { input: 10, output: 5 } };
      yield { type: "stop", reason: more ? "tool_use" : "end_turn" };
    } };
}

function settings(root: string, overrides: Record<string, unknown> = {}) {
  return { worker: image, checker: image, source: join(root, "source"), memoryCorpus: join(root, "corpus"),
    output: join(root, "evidence"), arm: "heuristics", dependencies: "offline-image",
    rounds: 1, maxMinutes: 10, totalTokens: 200_000, ...overrides };
}

async function prepared(overrides: Record<string, unknown> = {}) {
  const root = await temp("agentrig-r17f-");
  const transport = fixtureTransport();
  const cloned = await transport.command("git", ["clone", "--quiet", "--branch", "fixture", bundle, join(root, "source")]);
  expect(cloned.code).toBe(0);
  const corpus = await corpusModule.extractFrozenCorpus(join(root, "corpus"));
  expect(corpus.sha256).toBe(corpusModule.E3_CORPUS_SHA256);
  return { root, transport, settings: settings(root, overrides) };
}

it("recovers E3's frozen corpus from the published archive and refuses a disagreeing or reused one", async () => {
  const root = await temp("agentrig-r17f-corpus-");
  const recovered = await corpusModule.extractFrozenCorpus(join(root, "one"));
  expect(recovered.sha256).toBe("cd10a022f0114f75726f7d6024324ad92d4646a94d608af0fd2f9113e256b2a1");
  expect(recovered.source.attempts).toBe(48);
  expect(recovered.files).toBeGreaterThan(0);
  // An existing directory is an operator error, never a merge into someone else's evidence.
  await expect(corpusModule.extractFrozenCorpus(join(root, "one"))).rejects.toThrow(/EEXIST/);
  await writeFile(join(root, "not-the-archive"), "tampered");
  await expect(corpusModule.extractFrozenCorpus(join(root, "two"), join(root, "not-the-archive"))).rejects.toThrow(/published SHA-256/);
  const files = {
    "001-X1-s0m1-r1/wiki/index.md": { sha256: "a".repeat(64), base64: "" },
    "002-X1-s0m1-r1/wiki/index.md": { sha256: "b".repeat(64), base64: "" },
  };
  expect(() => corpusModule.frozenCorpusCopies({ files })).toThrow(/disagree/);
  expect(() => corpusModule.frozenCorpusCopies({ files: { "001-X1-s0m1-r1/wiki/../escape": { sha256: "", base64: "" } } })).toThrow(/unsafe/);
}, 60_000);

it("measures today's resolved defaults instead of restating them, and refuses a regressed profile", async () => {
  const root = await temp("agentrig-r17f-profile-");
  await mkdir(join(root, "home")); await mkdir(join(root, "cwd"));
  const profile = await runner.measuredProfile(join(root, "cwd"), join(root, "home"));
  expect(profile).toMatchObject({ supervise: true, checkpoints: false, ingestOnEnd: true,
    notifications: "bell", toolSummaries: true });
  // R17f's whole question presumes these two are still opt-in; if they ship on, stop.
  expect(profile.supervisorReview).toBeUndefined();
  expect(profile.supervisorAbort).toBeUndefined();
  const regressed = async () => ({ supervise: false });
  await expect(runner.measuredProfile(join(root, "cwd"), join(root, "home"), regressed)).rejects.toThrow(/not what R17f expects/);
  const shipped = async () => ({ supervise: true, checkpoints: false, ingestOnEnd: true, notifications: "bell",
    toolSummaries: true, supervisorReview: true });
  await expect(runner.measuredProfile(join(root, "cwd"), join(root, "home"), shipped)).rejects.toThrow(/opt-in/);
});

it("keeps the LLM ladder arm an explicit, recorded deviation from the shipped default", () => {
  const profile = { supervise: true };
  expect(runner.armProfile(profile, "heuristics")).toEqual({ profile, overrides: {} });
  const llm = runner.armProfile(profile, "heuristics+llm");
  expect(llm.profile.supervisorReview).toBe(true);
  expect(llm.overrides).toEqual({ supervisorReview: true });
  expect(profile).toEqual({ supervise: true }); // the resolved profile itself is never mutated
});

it("schedules balanced rounds of 32 in the frozen order and caps the authorized reserve", () => {
  const all = support.schedule();
  expect(all).toHaveLength(96);
  for (const rounds of [1, 2, 3]) {
    const block = all.slice(0, rounds * 32);
    for (const supervisor of [false, true]) for (const memory of [false, true])
      expect(block.filter(row => row.supervisor === supervisor && row.memory === memory)).toHaveLength(rounds * 8);
  }
  expect(runner.R17F_TOTAL_TOKENS).toBe(12_000_000);
  const base = { worker: image, checker: image, source: "/s", memoryCorpus: "/c", output: "/o",
    arm: "heuristics", dependencies: "offline-image", rounds: 1, maxMinutes: 10, totalTokens: 12_000_000 };
  expect(runner.Settings.parse(base)).toMatchObject({ rounds: 1 });
  expect(() => runner.Settings.parse({ ...base, totalTokens: 12_000_001 })).toThrow();
  expect(() => runner.Settings.parse({ ...base, rounds: 4 })).toThrow();
  // No default arm or dependency mode: choosing one silently would change the experiment.
  const { arm: _arm, ...noArm } = base;
  expect(() => runner.Settings.parse(noArm)).toThrow();
  const { dependencies: _dependencies, ...noDependencies } = base;
  expect(() => runner.Settings.parse(noDependencies)).toThrow();
});

it("answers permissions with R17d's preset policy: scoped grant confirmed, otherwise allow once", async () => {
  const cwd = await temp("agentrig-r17f-ask-");
  const grants = new PermissionGrantRegistry();
  const controller = new TuiController({ cwd, permissionGrants: grants,
    build: () => { throw new Error("no TUI tasks"); } });
  const approvals = runner.presetApprovals(controller, grants);
  // Core supplies this same durable-append callback; without a flush the registry refuses to
  // consume authority it has not yet audited.
  const context = { permissionGrants: grants, flushPermissionGrants: () => grants.flush(async () => {}) };
  const shell = (): PermissionRequest => ({ tool: "bash", class: "exec", cwd, input: { command: "git status --short" },
    operation: { kind: "shell", status: "parsed", shell: "/bin/sh", dialect: "posix-literal",
      argv: ["git", "status", "--short"], background: false } });
  expect(await approvals.ask(shell(), context)).toBe("allow");
  expect(grants.list()).toHaveLength(1);
  expect(approvals.prompts[0]).toMatchObject({ prompted: true, scopedGrantOffered: true, decision: "allow" });
  // The confirmed scoped grant now covers the identical request; nobody is asked twice.
  await context.flushPermissionGrants();
  expect(await approvals.ask(shell(), context)).toBe("allow");
  expect(approvals.prompts[1]).toMatchObject({ prompted: false, scopedGrantOffered: false });
  expect(grants.list()).toHaveLength(1);
  // A command with no supported literal argv cannot be scoped: allow once, no new grant.
  const unscopable: PermissionRequest = { tool: "bash", class: "exec", cwd, input: { command: "a | b" },
    operation: { kind: "shell", status: "unsupported", shell: "/bin/sh", reason: "shell operators", background: false } };
  expect(await approvals.ask(unscopable, context)).toBe("allow");
  expect(approvals.prompts[2]).toMatchObject({ prompted: true, scopedGrantOffered: false, decision: "allow" });
  expect(grants.list()).toHaveLength(1);
  // Never a standing all-requests answer for the tool.
  expect(JSON.stringify(grants.list())).not.toContain("\"resource\":\"*\",\"constraints\":{}");
});

it("bounds every provider request and stops the batch on unknown usage", async () => {
  const slow: ModelProvider = { id: "slow", model: "slow", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10 },
    async *stream(_request, signal) {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(resolve, 5_000).unref?.();
      });
      yield { type: "stop", reason: "end_turn" };
    } };
  const wrapped = runner.bounded(slow, 20);
  await expect((async () => { for await (const _event of wrapped.stream({} as never, new AbortController().signal)) { /* drained */ } })())
    .rejects.toThrow();
  expect(runner.REQUEST_TIMEOUT_MS).toBe(60_000);
  expect(runner.HANG_GUARD_MS).toBe(5 * 60_000 + 90_000);
});

it("allows once when a parsed command is too large for a scoped-grant preview", async () => {
  const cwd = await temp("agentrig-r17f-preview-"), grants = new PermissionGrantRegistry();
  grants.beginSession("preview-fixture");
  const controller = new TuiController({ cwd, permissionGrants: grants, build: () => { throw new Error("unused"); } });
  const command = Array(128).fill("x".repeat(127)).join(" ");
  const operation = describeShellOperation(command, "/bin/sh");
  expect(operation.status).toBe("parsed");
  const answer = runner.presetApprovals(controller, grants).ask({ tool: "bash", class: "exec", cwd,
    input: { command }, operation });
  const result = await Promise.race([answer, new Promise(resolve => setTimeout(() => resolve("wedged"), 100))]);
  controller.cancelPermissionScope(); controller.answerPermission("deny");
  expect(result).toBe("allow");
  expect(grants.list()).toHaveLength(0);
});

it("passes the measurement abort signal into permission prompts", async () => {
  const cwd = await temp("agentrig-r17f-abort-"), grants = new PermissionGrantRegistry();
  grants.beginSession("aborted-fixture");
  const controller = new TuiController({ cwd, permissionGrants: grants, build: () => { throw new Error("unused"); } });
  const signal = AbortSignal.abort();
  const result = await runner.presetApprovals(controller, grants, signal).ask({ tool: "bash", class: "exec", cwd,
    input: { command: "git status" }, operation: describeShellOperation("git status", "/bin/sh") });
  expect(result).toBe("deny");
  expect(controller.snapshot().pending).toBeNull();
  expect(grants.list()).toHaveLength(0);
});

it("runs the preregistered slots on a fake provider with real defaults, permissions and R17e lines", async () => {
  const { root, transport, settings: input } = await prepared();
  const requests: string[] = [];
  // Slots 17-20 are X1's four configurations in repetition one, in their frozen order.
  const result = await runner.run(input, { transport, slots: [16, 17, 18, 19], provider: () => {
    const inner = scripted();
    return { ...inner, async *stream(request: Parameters<ModelProvider["stream"]>[0], signal: AbortSignal) {
      requests.push(request.system); yield* inner.stream(request, signal);
    } };
  } });
  expect(result.blocked).toBeNull();
  expect(result.completed).toHaveLength(4);
  // Frozen E1 TASK.md omits these evaluator-owned filename rules for several tasks.
  // Original E3 disclosed them in the common system prompt; every candidate must receive them.
  expect(requests[0]).toContain("packages/memory/test/eval-<lowercase-kebab-name>.test.ts");
  expect(requests[0]).toContain("eval-test-<lowercase-kebab-name>.js");
  expect(requests[0]).toContain("External tests must run directly with node and built-in assert");

  const protocol = JSON.parse(await readFile(join(root, "evidence", "protocol.json"), "utf8"));
  expect(protocol.model).toMatchObject({ model: "gpt-5.6-luna", reasoningEffort: "medium", apiKeyFallback: false });
  expect(protocol.profile).toMatchObject({ supervise: true, toolSummaries: true });
  expect(protocol.corpus.sha256).toBe(corpusModule.E3_CORPUS_SHA256);
  expect(protocol.arm).toBe("heuristics");
  expect(protocol.armOverrides).toEqual({});
  expect(protocol.limitations.join(" ")).toMatch(/not an interactive usability comparison/);

  const keys = ["017-X1-s0m0-r1", "018-X1-s0m1-r1", "019-X1-s1m0-r1", "020-X1-s1m1-r1"];
  for (const key of keys) {
    const directory = join(root, "evidence", key);
    const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    expect(report.outcome).toBe("PASS"); // independent E1 checks, not the model's own claim
    const timing = JSON.parse(await readFile(join(directory, "session-timing.json"), "utf8"));
    const orchestration = JSON.parse(await readFile(join(directory, "orchestration-timing.json"), "utf8"));
    expect(timing.settledAt).toBeGreaterThanOrEqual(timing.startedAt);
    expect(orchestration.primarySessionTiming).toEqual(timing);
    expect(orchestration.settledAt).toBeGreaterThanOrEqual(timing.settledAt);
    expect(await readFile(join(directory, "artifacts", "eval-test-fix.js"), "utf8"))
      .toContain("assert.equal");
    const memoryOn = key.includes("m1");
    expect(report.configuration.memory).toBe(memoryOn);
    expect(report.configuration.supervisor).toBe(key.includes("s1"));

    // The permission surface is real, not a blanket allow: three shell calls produced two
    // prompts, because the confirmed argv-prefix grant covered the identical repeat before it
    // ever reached the approval handler. The unscopable command still asked, and allowed once.
    const permissions = JSON.parse(await readFile(join(directory, "permissions.json"), "utf8"));
    expect(permissions.prompts).toHaveLength(2);
    expect(permissions.prompts[0]).toMatchObject({ tool: "bash", class: "exec", prompted: true, scopedGrantOffered: true, decision: "allow" });
    expect(permissions.prompts[1]).toMatchObject({ tool: "bash", prompted: true, scopedGrantOffered: false, decision: "allow" });
    expect(permissions.grants).toHaveLength(1);
    expect(permissions.grants[0].operation.commandPrefix).toEqual(["git", "status", "--short"]);
    expect(permissions.grants[0].resource).toBe("*"); // argv-prefix scope, exact cwd, session only
    expect(permissions.grants[0].constraints.cwd).toBe(join(root, "evidence", `${key}-workspace`));
    expect(permissions.responsePolicy).toMatch(/never allow-all/);

    const transcript = await readFile(join(directory, "transcript.txt"), "utf8");
    expect(transcript.split("\n").filter(line => line.startsWith("⚒ bash"))).toHaveLength(3);
    // R17e: file changes the detectors saw are in the transcript, not only in the log.
    expect(transcript).toMatch(/± edit index\.js/);
    // R17e: the injected memory index announces itself exactly when memory is on.
    expect(/memory in the prompt/.test(transcript)).toBe(memoryOn);
    const why = JSON.parse(await readFile(join(directory, "why.json"), "utf8"));
    expect(typeof why.rendered).toBe("string");
    expect(why.rendered.length).toBeGreaterThan(0);
    // No advisory model call is made in any measured cell.
    expect(JSON.parse(await readFile(join(directory, "advisory.json"), "utf8"))).toMatchObject({ advisory: null, requested: false });
  }

  // The frozen corpus reaches memory-on attempts byte-exactly and nowhere else.
  expect(await readFile(join(root, "evidence", "018-X1-s0m1-r1", "memory", "index.md"), "utf8"))
    .toBe(await readFile(join(root, "corpus", "index.md"), "utf8"));
  await expect(readFile(join(root, "evidence", "017-X1-s0m0-r1", "memory", "index.md"))).rejects.toThrow();

  // results.json is the shape the existing balanced-subset summary already reads.
  const results = JSON.parse(await readFile(join(root, "evidence", "results.json"), "utf8"));
  const progress = (await readFile(join(root, "evidence", "progress.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  expect(progress.filter(row => row.phase === "call-start")).toHaveLength(16);
  expect(progress.filter(row => row.phase === "call-settled")).toHaveLength(16);
  expect(progress.filter(row => row.phase === "attempt-settled")).toHaveLength(4);
  for (const key of keys) {
    const timing = JSON.parse(await readFile(join(root, "evidence", key, "session-timing.json"), "utf8"));
    expect(results.completed.find((row: { key: string }) => row.key === key).wallMs)
      .toBe(timing.settledAt - timing.startedAt);
  }
  const summarized = summary.summarize(results);
  expect(summarized.groups.map(group => group.completed)).toEqual([1, 1, 1, 1]);
  expect(summarized.groups.map(group => group.notRun)).toEqual([23, 23, 23, 23]);
}, 180_000);

it("stops before the next attempt when a provider call leaves usage unknown, and keeps what it has", async () => {
  const { root, transport, settings: input } = await prepared();
  const result = await runner.run(input, { transport, slots: [16, 17], provider: () => scripted(false) });
  expect(result.blocked).toMatch(/usage is incomplete/);
  expect(result.completed).toHaveLength(1); // the incomplete attempt still produced its evidence
  const results = JSON.parse(await readFile(join(root, "evidence", "results.json"), "utf8"));
  expect(results.ledger.unknownCalls).toBeGreaterThan(0);
  expect(results.planned).toBe(96);
  expect(summary.summarize(results).groups.map(group => group.completed)).toEqual([1, 0, 0, 0]);
}, 180_000);

it("refuses an uncommitted evaluator, an unfrozen corpus and a reused evidence root", async () => {
  const { root, transport, settings: input } = await prepared();
  const dirty: EvaluationTransport = { ...transport, async command(program, args, options) {
    if (program === "git" && options?.cwd === repo && args[0] === "status")
      return { code: 0, infrastructure: false, stdout: " M eval/r17f.mjs\n", stderr: "", error: null };
    return transport.command(program, args, options);
  } };
  const blocked = await runner.run({ ...input, output: join(root, "dirty") }, { transport: dirty, slots: [] });
  expect(blocked.blocked).toMatch(/commit the frozen R17f evaluator/);

  await writeFile(join(root, "corpus", "index.md"), "tampered\n");
  const tampered = await runner.run({ ...input, output: join(root, "tampered") }, { transport, slots: [] });
  expect(tampered.blocked).toMatch(/digest mismatch/);

  await expect(runner.run({ ...input, output: join(root, "dirty") }, { transport, slots: [] })).rejects.toThrow(/EEXIST/);
}, 120_000);

it.each(["heuristics", "heuristics+llm"])("puts R17e supervisor lines and /why into the evidence with %s", async arm => {
  const { root, transport, settings: input } = await prepared({ arm });
  // Slot 19 is X1 supervisor-on, memory-off in repetition one.
  const result = await runner.run(input, { transport, slots: [18], provider: () => idling(12) });
  expect(result.blocked).toBeNull();
  const directory = join(root, "evidence", "019-X1-s1m0-r1");
  const transcript = await readFile(join(directory, "transcript.txt"), "utf8");
  const noticed = transcript.split("\n").filter(line => line.startsWith("⚠ supervisor:"));
  const outcomes = transcript.split("\n").filter(line => line.trimStart().startsWith("↳ "));
  // The default wrap-up window is 15 of 24 turns, so budget guidance is reached here.
  expect(noticed.length).toBeGreaterThan(0);
  expect(noticed[0]).toMatch(/noticed .+ → inject_guidance/);
  expect(outcomes.length).toBeGreaterThan(0);
  expect(outcomes[0]).toMatch(/queued|applied|no-action|unavailable/);
  // A queued decision is never rendered as one that already happened.
  const log = await readFile(join(directory, "sessions", `${JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).runId}.jsonl`), "utf8");
  expect(log).toMatch(/"type":"supervisor\.outcome"/);
  const why = JSON.parse(await readFile(join(directory, "why.json"), "utf8"));
  expect(why.rendered).toMatch(/supervisor|guidance|turn/i);
  expect(why.authority).toMatch(/not a provider call/);
  const auxiliary = JSON.parse(await readFile(join(directory, "auxiliary.json"), "utf8"));
  expect(auxiliary.supervisorReportsUnpaired).toBeUndefined();
  if (arm === "heuristics+llm") expect(auxiliary.snapshots.length).toBeGreaterThan(0);
  else expect(auxiliary.snapshots).toHaveLength(0);
}, 180_000);

it("stops the matrix if the frozen corpus changes between attempts, keeping the attempts already collected", async () => {
  const { root, transport, settings: input } = await prepared();
  let checked = 0;
  const tampering: EvaluationTransport = { ...transport, async worker(options, args, signal, timeout) {
    const result = await transport.worker(options, args, signal, timeout);
    if (options.checkerReceipt !== undefined && ++checked === 1)
      await writeFile(join(root, "corpus", "index.md"), "changed between attempts\n");
    return result;
  } };
  // Both slots are memory-off, so only the per-attempt re-verification can notice the change.
  const result = await runner.run(input, { transport: tampering, slots: [16, 18], provider: () => scripted() });
  expect(result.blocked).toMatch(/digest mismatch/);
  expect(result.completed).toHaveLength(1);
}, 180_000);

it("refuses a failed cleanliness check even when its stdout is empty", async () => {
  const { root, transport, settings: input } = await prepared();
  for (const [index, failure] of [{ code: 128, infrastructure: false }, { code: 0, infrastructure: true }].entries()) {
    let preflight = false;
    const failing: EvaluationTransport = { ...transport,
      preflight: async () => { preflight = true; },
      async command(program, args, options) {
        if (program === "git" && options?.cwd === repo && args[0] === "status")
          return { ...failure, stdout: "", stderr: "failed status check", error: "unavailable" };
        return transport.command(program, args, options);
      } };
    const result = await runner.run({ ...input, output: join(root, `failed-status-${index}`) }, { transport: failing, slots: [] });
    expect(result.blocked).toMatch(/cannot verify.*clean/);
    expect(preflight).toBe(false);
  }
}, 120_000);

it("keeps final results and call accounting when a progress append fails", async () => {
  const { root, transport, settings: input } = await prepared();
  const failing: EvaluationTransport = { ...transport, async worker(options, args, signal, timeout) {
    const result = await transport.worker(options, args, signal, timeout);
    if (options.checkerReceipt !== undefined) {
      const journal = join(root, "evidence", "progress.jsonl");
      await rename(journal, `${journal}.retained`);
      await mkdir(journal); // deterministic append failure, while other final evidence remains writable
    }
    return result;
  } };
  const result = await runner.run(input, { transport: failing, slots: [16], provider: () => scripted() });
  expect(result.blocked).toMatch(/EISDIR/);
  const saved = JSON.parse(await readFile(join(root, "evidence", "results.json"), "utf8"));
  expect(saved.ledger.tokens).toBe(result.tokens);
  expect(saved.ledger.blocked).toMatch(/EISDIR/);
  expect(JSON.parse(await readFile(join(root, "evidence", "calls.json"), "utf8"))).toHaveLength(4);
}, 120_000);

it("operator cancellation settles the session and preserves unknown-call accounting on the last slot", async () => {
  const { root, transport, settings: input } = await prepared(), controller = new AbortController();
  const provider: ModelProvider = { ...scripted(), async *stream(_request, signal) {
    yield { type: "text_delta", text: "partial before operator stop" };
    controller.abort(); signal.throwIfAborted();
    yield { type: "stop", reason: "end_turn" };
  } };
  const result = await runner.run(input, { transport, slots: [16], provider: () => provider, signal: controller.signal });
  expect(result.blocked).toMatch(/cancelled/);
  const saved = JSON.parse(await readFile(join(root, "evidence", "results.json"), "utf8"));
  expect(saved.ledger.unknownCalls).toBe(1);
  expect(saved.ledger.blocked).toMatch(/cancelled/);
  const calls = JSON.parse(await readFile(join(root, "evidence", "calls.json"), "utf8"));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ complete: false, usage: null });
}, 120_000);

it("joins operator signals through cancellation without removing unrelated handlers", () => {
  const source = new EventEmitter(), controller = new AbortController();
  let unrelated = 0;
  source.on("SIGTERM", () => { unrelated++; });
  const dispose = runner.measurementSignals(controller, source);
  source.emit("SIGTERM");
  expect(controller.signal.aborted).toBe(true);
  dispose();
  expect(source.listenerCount("SIGINT")).toBe(0);
  expect(source.listenerCount("SIGTERM")).toBe(1);
  expect(unrelated).toBe(1);
});
