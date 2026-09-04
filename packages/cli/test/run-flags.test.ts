import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortNotice, parseSoft, parseTurnsRemaining, runCommand, supervisorOptions, type RunOptions } from "../src/run.ts";
import { parseBudget } from "../src/agent-builder.ts";

/**
 * The supervisor CLI surface had no tests at all. These drive `runCommand` directly with no
 * provider credentials, so every case fails fast at provider construction — which is exactly
 * what makes them useful: a flag that fails *validation* reports its own message and never
 * reaches the provider, so the two error paths are distinguishable.
 */
let root: string;
let errors: string[];
let logs: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-cli-"));
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

function opts(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    provider: "anthropic",
    model: "m",
    root,
    headless: true,
    maxTurns: "10",
    maxTokensPerTurn: "1024",
    supervisorSoft: "0.8",
    supervisorTurnsRemaining: "15",
    dreamEverySessions: "10",
    dreamEveryHours: "24",
    ...overrides,
  } as RunOptions;
}

const ranWithoutCredentials = (): boolean => errors.some((e) => /api key|API key|ANTHROPIC/i.test(e));

describe("--supervisor-soft validation", () => {
  it("accepts a fraction in (0, 1]", async () => {
    for (const soft of ["0.5", "0.8", "1"]) {
      errors = [];
      await runCommand("t", opts({ supervise: true, supervisorSoft: soft }));
      // it got past validation: the only complaint is the missing credential
      expect(errors.some((e) => e.includes("--supervisor-soft"))).toBe(false);
      expect(ranWithoutCredentials()).toBe(true);
    }
  });

  it("rejects a fraction above 1, naming the flag", async () => {
    await runCommand("t", opts({ supervise: true, supervisorSoft: "1.5" }));
    expect(errors.some((e) => e.includes("--supervisor-soft") && e.includes("fraction"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("rejects zero, negatives and non-numbers", async () => {
    for (const bad of ["0", "-1", "abc", "", " ", "NaN", "Infinity"]) {
      errors = [];
      await runCommand("t", opts({ supervise: true, supervisorSoft: bad }));
      expect(errors.some((e) => e.includes("--supervisor-soft"))).toBe(true);
      expect(process.exitCode).toBe(1);
    }
  });

  it("is validated even when --supervise is off, so a typo is never silently carried", async () => {
    await runCommand("t", opts({ supervisorSoft: "nope" }));
    expect(errors.some((e) => e.includes("--supervisor-soft"))).toBe(true);
  });
});

describe("--supervisor-turns-remaining validation", () => {
  it("accepts a positive integer and rejects fractional or non-positive counts", async () => {
    await runCommand("t", opts({ supervisorTurnsRemaining: "20" }));
    expect(errors.some((e) => e.includes("--supervisor-turns-remaining"))).toBe(false);
    expect(ranWithoutCredentials()).toBe(true);

    for (const bad of ["0", "-1", "1.5", "many"]) {
      errors = [];
      await runCommand("t", opts({ supervisorTurnsRemaining: bad }));
      expect(errors.some((e) => e.includes("--supervisor-turns-remaining"))).toBe(true);
    }
  });

  it("parses the configured count for shared run/TUI wiring", () => {
    expect(parseTurnsRemaining("15")).toBe(15);
    expect(() => parseTurnsRemaining("2.5")).toThrow(/integer/);
  });
});

describe("session_end hook flag validation", () => {
  it("rejects a non-positive --dream-every-sessions", async () => {
    await runCommand("t", opts({ dreamEverySessions: "0" }));
    expect(errors.some((e) => e.includes("--dream-every-sessions"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a non-numeric --dream-every-hours", async () => {
    await runCommand("t", opts({ dreamEveryHours: "soon" }));
    expect(errors.some((e) => e.includes("--dream-every-hours"))).toBe(true);
  });

  it("accepts sensible cadences", async () => {
    await runCommand("t", opts({ dreamEverySessions: "5", dreamEveryHours: "12" }));
    expect(errors.some((e) => e.includes("--dream-every"))).toBe(false);
    expect(ranWithoutCredentials()).toBe(true);
  });
});

describe("budget flag validation still holds alongside the supervisor flags", () => {
  it("rejects a non-positive --max-turns", async () => {
    await runCommand("t", opts({ maxTurns: "0" }));
    expect(errors.some((e) => e.includes("--max-turns"))).toBe(true);
  });

  it("requires --price-in and --price-out together", async () => {
    await runCommand("t", opts({ priceIn: "3" }));
    expect(errors.some((e) => e.includes("--price-in and --price-out"))).toBe(true);
  });

  it("requires pricing for --max-usd", async () => {
    await runCommand("t", opts({ maxUsd: "5" }));
    expect(errors.some((e) => e.includes("--max-usd requires"))).toBe(true);
  });

  it("accepts explicit cache prices as overrides and requires base pricing", () => {
    const parsed = parseBudget(opts({
      priceIn: "10",
      priceOut: "20",
      priceCacheRead: "0.7",
      priceCacheWrite: "12.5",
    }));
    expect(parsed.pricing).toEqual({
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 20,
      cacheReadUsdPerMTok: 0.7,
      cacheWriteUsdPerMTok: 12.5,
    });
    expect(() => parseBudget(opts({ priceCacheRead: "0.7" }))).toThrow(/--price-in and --price-out/);
  });
});

/**
 * `supervisorOptions` is exported and pure precisely because it used to be inline in
 * `runCommand`: the only way to check a flag reached the supervisor was to run a whole session,
 * so nothing did, and `--drift-scope` could be deleted from the wiring with every test still green.
 */
describe("supervisorOptions", () => {
  const wiring = (over: Partial<Parameters<typeof supervisorOptions>[0]> = {}) =>
    supervisorOptions({
      opts: {},
      task: "do the thing",
      budget: { maxTurns: 40 },
      memoryIndex: "",
      provider: { id: "fake", model: "m" } as never,
      soft: 0.8,
      turnsRemaining: 15,
      ...over,
    });

  it("leaves the contract watchlist alone when the flag is absent", () => {
    // Load-bearing: commander defaults `--drift-contract` to `undefined`, NOT `[]`, so an absent
    // flag leaves `DriftOptions.contract` unset and the detector's own default list applies.
    // Defaulting it to `[]` — the obvious edit, for consistency with --drift-scope — would pass
    // an empty watchlist and silently switch the whole feature off for every run.
    expect(wiring().drift).not.toHaveProperty("contract");
    expect(wiring({ opts: { driftContract: [] } }).drift).toHaveProperty("contract", []);
  });

  it("carries --drift-scope and --drift-contract through to the detector", () => {
    expect(
      wiring({ opts: { driftScope: ["packages/core"], driftContract: ["custom.config.ts"] } }).drift,
    ).toEqual({
      scope: ["packages/core"],
      contract: ["custom.config.ts"],
    });
  });

  it("passes an empty scope when the flag was not given, which the detector reads as silence", () => {
    expect(wiring().drift).toEqual({ scope: [] });
  });

  it("enables abort only when --supervisor-abort is explicitly present", () => {
    expect(wiring({ opts: { supervisorAbort: true } }).capabilities).toEqual({ abort: true });
    expect(wiring().capabilities).toEqual({ abort: false });
  });

  it("keeps --supervisor-no-abort as a compatibility no-op", () => {
    expect(wiring({ opts: { supervisorNoAbort: true } }).capabilities).toEqual({ abort: false });
  });

  it("only builds the model-backed rungs when --supervisor-review asked for them", () => {
    const plain = wiring();
    expect(plain.reviewer).toBeUndefined();
    expect(plain.grader).toBeUndefined();
    const reviewed = wiring({ opts: { supervisorReview: true } });
    expect(reviewed.reviewer).toBeDefined();
    expect(reviewed.grader).toBeDefined();
  });

  it("carries provider cache pricing into the supervisor", () => {
    const o = wiring({
      provider: {
        id: "fake",
        model: "m",
        capabilities: {
          tools: true,
          parallelTools: false,
          caching: true,
          contextWindow: 1_000,
          cacheReadDiscount: 0.1,
          cacheWriteMultiplier: 1.25,
        },
      } as never,
    });
    expect(o.cacheReadDiscount).toBe(0.1);
    expect(o.cacheWriteMultiplier).toBe(1.25);
  });

  it("carries the budget the session is actually running under", () => {
    const o = wiring({
      budget: { maxTurns: 10, maxTokens: 500, maxUsd: 2, maxMinutes: 30 },
      soft: 0.5,
      turnsRemaining: 7,
    });
    expect(o.budget).toEqual({
      soft: 0.5,
      turnsRemaining: 7,
      maxTurns: 10,
      maxTokens: 500,
      maxUsd: 2,
      maxMinutes: 30,
    });
  });

  it("builds the reviewer and grader on reviewProvider while accounting stays on provider (R3.5a)", () => {
    const accounting = { id: "main", model: "m", capabilities: { cacheReadDiscount: 0.25, cacheWriteMultiplier: 2 } } as never;
    const judge = { id: "judge", model: "j", capabilities: {} } as never;
    const o = wiring({ opts: { supervisorReview: true }, provider: accounting, reviewProvider: judge });
    expect(o.cacheReadDiscount).toBe(0.25);
    expect(o.cacheWriteMultiplier).toBe(2);
    // the reviewer/grader classes keep their provider private; assert through the injected object identity
    expect((o.reviewer as unknown as { opts: { provider: unknown } }).opts.provider).toBe(judge);
  });
});

describe("parseSoft", () => {
  it("accepts a fraction and rejects a count, since it is a fraction of the budget", () => {
    expect(parseSoft("0.5")).toBe(0.5);
    expect(parseSoft("1")).toBe(1);
    expect(() => parseSoft("80")).toThrow(/fraction of the budget/);
    expect(() => parseSoft("lots")).toThrow(/--supervisor-soft/);
  });
});

describe("abortNotice (#88)", () => {
  it("says what the first and second abort do, and nothing for a third", () => {
    expect(abortNotice(1, "ctrl-C")).toBe("aborting… (ctrl-C again to skip session_end hooks)");
    expect(abortNotice(2, "ctrl-C")).toBe("skipping session_end hooks");
    expect(abortNotice(3, "ctrl-C")).toBeNull();
    // the first never claims the hooks are running: a finished session in its hooks is cut by it
    expect(abortNotice(1, "ctrl-C")).not.toMatch(/still run/);
  });
});
