import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviders, resolveProviderEntries, type ProviderOptions } from "../src/provider.ts";

const base: ProviderOptions = {
  provider: "openai",
  model: "default-model",
  baseUrl: "http://127.0.0.1:1/v1",
  modelExplicit: true,
  providers: {
    cloud: { provider: "openai", model: "cloud-model", baseUrl: "http://127.0.0.1:2/v1", reasoningEffort: "max" },
    local: { provider: "openai", model: "local-model", baseUrl: "http://127.0.0.1:3/v1", contextWindow: 98304 },
  },
  roles: { main: "cloud", subagents: "local" },
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveProviderEntries", () => {
  it("falls back role → main → default", () => {
    const r = resolveProviderEntries(base);
    expect(r.roleNames).toEqual({ main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" });
    expect(Object.keys(r.entries).sort()).toEqual(["cloud", "default", "local"]);
    expect(r.entries.default).toEqual({ provider: "openai", model: "default-model", baseUrl: "http://127.0.0.1:1/v1" });
  });

  it("with no providers block every role is the flat default entry", () => {
    const r = resolveProviderEntries({ provider: "anthropic", model: "m" });
    expect(r.roleNames).toEqual({ main: "default", supervisor: "default", memory: "default", subagents: "default" });
  });

  it("a typed provider flag moves ONLY main to default", () => {
    const r = resolveProviderEntries({ ...base, providerOverride: true });
    expect(r.roleNames).toEqual({ main: "default", supervisor: "cloud", memory: "cloud", subagents: "local" });
  });

  it("names the role and the missing entry", () => {
    expect(() => resolveProviderEntries({ ...base, roles: { memory: "wiki" } })).toThrow(/role memory names unknown provider entry "wiki"; defined entries: cloud, default, local/);
  });

  it("carries the flat contextWindow and reasoningEffort into the default entry", () => {
    const r = resolveProviderEntries({ provider: "openai", model: "m", baseUrl: "http://x/v1", contextWindow: 4096, reasoningEffort: "low" });
    expect(r.entries.default).toEqual({ provider: "openai", model: "m", baseUrl: "http://x/v1", contextWindow: 4096, reasoningEffort: "low" });
  });
});

describe("buildProviders", () => {
  it("builds one instance per entry and shares it across roles", () => {
    const set = buildProviders(base);
    expect(set.main).toBe(set.supervisor);
    expect(set.main).toBe(set.memory);
    expect(set.subagents).not.toBe(set.main);
    expect(set.main.model).toBe("cloud-model");
    expect(set.subagents.model).toBe("local-model");
    expect(set.get("local")).toBe(set.subagents);
    expect(set.names).toEqual(["cloud", "local", "default"]);
    expect(set.roleNames.subagents).toBe("local");
  });

  it("applies contextWindow to the adapter", () => {
    expect(buildProviders(base).subagents.capabilities.contextWindow).toBe(98304);
  });

  it("fails at construction naming the role and entry when a credential is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const opts: ProviderOptions = { ...base, providers: { ...base.providers, judge: { provider: "anthropic", model: "claude-x" } }, roles: { supervisor: "judge" } };
    expect(() => buildProviders(opts)).toThrow(/role supervisor \(provider entry "judge"\): ANTHROPIC_API_KEY is not set/);
  });

  it("get() rejects a name that is not an entry", () => {
    expect(() => buildProviders(base).get("nope")).toThrow(/unknown provider entry "nope"/);
  });

  it("does not construct an entry no role references until get() asks for it", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const opts: ProviderOptions = { ...base, providers: { ...base.providers, spare: { provider: "anthropic", model: "claude-x" } } };
    const set = buildProviders(opts);
    expect(set.names).toContain("spare");
    expect(() => set.get("spare")).toThrow(/ANTHROPIC_API_KEY/);
  });
});
