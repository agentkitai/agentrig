import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGPTTokens, LoopbackLogin } from "@agentkitai/agentrig-core";
import { loginCommand, type AuthLike } from "../src/login.ts";

/**
 * `login` had no tests: signing in for real needs a browser and a person, so the command was the
 * one surface nothing covered. Everything except that one interaction is ordinary code.
 */
let errors: string[];
let logs: string[];

beforeEach(() => {
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const err = (): string => errors.join("\n");

function fakeAuth(over: Partial<AuthLike> = {}): AuthLike {
  return {
    exportTokens: async () => null,
    startLoopbackLogin: async (): Promise<LoopbackLogin> => ({
      url: "https://auth.example/oauth/authorize?state=x",
      redirectUri: "http://localhost:1455/auth/callback",
      complete: async () => ({ accessToken: "a", refreshToken: "r", accountId: "acct_9" }),
      cancel: () => {},
    }),
    ...over,
  };
}

describe("agentrig login", () => {
  it("refuses a provider that has no sign-in, rather than pretending", async () => {
    await loginCommand("anthropic");
    expect(err()).toContain("unknown provider");
    expect(process.exitCode).toBe(1);
  });

  it("prints the URL before waiting, so a browser that does not open is not a dead end", async () => {
    const opened: string[] = [];
    await loginCommand("openai-chatgpt", { makeAuth: fakeAuth, openBrowser: (u) => opened.push(u) });

    expect(err()).toContain("https://auth.example/oauth/authorize");
    expect(err()).toContain("http://localhost:1455/auth/callback");
    expect(opened).toEqual(["https://auth.example/oauth/authorize?state=x"]);
  });

  it("--no-browser waits without launching one", async () => {
    const opened: string[] = [];
    await loginCommand("openai-chatgpt", { makeAuth: fakeAuth, noBrowser: true, openBrowser: (u) => opened.push(u) });
    expect(opened).toEqual([]);
    // the URL is still printed — that is the whole point of the flag
    expect(err()).toContain("https://auth.example/oauth/authorize");
  });

  it("says what to run next, with a model, since this provider requires one", async () => {
    await loginCommand("openai-chatgpt", { makeAuth: fakeAuth, noBrowser: true });

    expect(err()).toContain("Signed in");
    expect(err()).toContain("acct_9");
    expect(err()).toContain("Start working");
    // a hint with no --model is a hint that does not run
    expect(err()).toMatch(/agentrig --provider openai-chatgpt --model \S+/);
    expect(err()).toMatch(/agentrig run "<task>"/);
    expect(process.exitCode).toBeUndefined();
  });

  it("says the credential is saved and that nothing needs setting", async () => {
    await loginCommand("openai-chatgpt", { makeAuth: fakeAuth, noBrowser: true });

    // the login already stored it; a reader who comes away thinking they must export it has been
    // told the wrong thing by their own tool
    expect(err()).toMatch(/Saved to .*openai-chatgpt-auth\.json/);
    expect(err()).toContain("nothing to add to your environment");
  });

  it("frames --export as the exception it is, not as the next step", async () => {
    await loginCommand("openai-chatgpt", { makeAuth: fakeAuth, noBrowser: true });

    const hint = err().slice(err().indexOf("--export") - 200);
    expect(hint).toContain("Optional");
    // it is for a machine that cannot run this command at all
    expect(hint).toMatch(/no browser|cannot sign in/i);
  });

  it("reports a failed sign-in and exits non-zero", async () => {
    const auth = fakeAuth({
      startLoopbackLogin: async () => ({
        url: "u",
        redirectUri: "r",
        complete: async () => {
          throw new Error("authorization failed: access_denied");
        },
        cancel: () => {},
      }),
    });
    await loginCommand("openai-chatgpt", { makeAuth: () => auth, noBrowser: true });

    expect(err()).toContain("access_denied");
    expect(process.exitCode).toBe(1);
  });

  it("--export puts the credential on stdout and the instructions on stderr", async () => {
    // a distinctive value: asserting that stderr lacks "a" passes on any English sentence
    const tokens: ChatGPTTokens = { accessToken: "SECRET-ACCESS-TOKEN", refreshToken: "SECRET-REFRESH" };
    await loginCommand("openai-chatgpt", { export: true, makeAuth: () => fakeAuth({ exportTokens: async () => tokens }) });

    // the bundle IS a credential: it goes to stdout alone so `| pbcopy` gets only that
    expect(logs).toEqual([JSON.stringify(tokens)]);
    expect(err()).toContain("AGENTRIG_OPENAI_CHATGPT_TOKEN");
    expect(err()).not.toContain(tokens.accessToken);
    // ...and it says where THIS machine already reads it from, so the export is not mistaken for
    // something the local setup needs
    expect(err()).toMatch(/already reads it from/);
  });

  it("--export when signed out says so instead of printing null", async () => {
    await loginCommand("openai-chatgpt", { export: true, makeAuth: fakeAuth });
    expect(logs).toEqual([]);
    expect(err()).toContain("not signed in");
    expect(process.exitCode).toBe(1);
  });
});
