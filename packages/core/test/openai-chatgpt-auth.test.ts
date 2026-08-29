import { describe, expect, it } from "vitest";
import {
  EnvSeededTokenStore,
  OpenAIChatGPTAuth,
  decodeJwtClaims,
  tokensFromEnvValue,
  type ChatGPTTokens,
  type TokenStore,
} from "@agentkitai/agentrig-core";

/** Build a fake JWT with the given payload claims (signature is never checked). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

class MemoryStore implements TokenStore {
  constructor(public tokens: ChatGPTTokens | null = null) {}
  async read() {
    return this.tokens;
  }
  async write(t: ChatGPTTokens) {
    this.tokens = t;
  }
}

const accessJwt = (expSec: number, account = "acct_1") =>
  jwt({ exp: expSec, chatgpt_account_id: account });

describe("decodeJwtClaims", () => {
  it("decodes the payload segment and tolerates junk", () => {
    expect(decodeJwtClaims(jwt({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
  });
});

describe("OpenAIChatGPTAuth device login", () => {
  it("requests a user code and polls until authorized, persisting tokens", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    let poll = 0;
    const fetchFn: typeof fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/deviceauth/usercode")) {
        return new Response(JSON.stringify({ device_code: "dev", user_code: "WXYZ", verification_uri: "https://x/device", interval: 1, expires_in: 900 }), { status: 200 });
      }
      // first poll pending, second authorized
      if (poll++ === 0) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      return new Response(
        JSON.stringify({ access_token: accessJwt(now / 1000 + 3600), refresh_token: "r1", id_token: jwt({ chatgpt_account_id: "acct_9" }) }),
        { status: 200 },
      );
    };
    const store = new MemoryStore();
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, sleep: async () => {} });

    const login = await auth.startDeviceLogin();
    expect(login.userCode).toBe("WXYZ");
    expect(login.verificationUri).toBe("https://x/device");
    const tokens = await login.complete();

    expect(tokens.refreshToken).toBe("r1");
    expect(tokens.accountId).toBe("acct_9");
    expect(store.tokens?.accessToken).toContain(".");
    expect(calls.filter((c) => c.endsWith("/deviceauth/token"))).toHaveLength(2);
  });

  it("throws a clear error on device denial", async () => {
    const fetchFn: typeof fetch = async (url) =>
      String(url).endsWith("/usercode")
        ? new Response(JSON.stringify({ device_code: "d", user_code: "C", interval: 1, expires_in: 900 }), { status: 200 })
        : new Response(JSON.stringify({ error: "access_denied" }), { status: 400 });
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(), fetchFn, sleep: async () => {} });
    const login = await auth.startDeviceLogin();
    await expect(login.complete()).rejects.toThrow(/access_denied/);
  });
});

describe("tokensFromEnvValue", () => {
  it("parses AgentRig's native bundle shape", () => {
    const raw = JSON.stringify({ accessToken: "a", refreshToken: "r", accountId: "acct_1" });
    expect(tokensFromEnvValue(raw)).toMatchObject({ accessToken: "a", refreshToken: "r", accountId: "acct_1" });
  });

  it("parses Codex's auth.json shape (tokens: { access_token, ... })", () => {
    const raw = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", id_token: "i", account_id: "acct_2" } });
    expect(tokensFromEnvValue(raw)).toEqual({ accessToken: "a", refreshToken: "r", idToken: "i", accountId: "acct_2" });
  });

  it("returns null for junk", () => {
    expect(tokensFromEnvValue("not json")).toBeNull();
    expect(tokensFromEnvValue(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});

describe("EnvSeededTokenStore", () => {
  it("falls back to the env var when the file is empty, and writes go to the file", async () => {
    const file = new MemoryStore(null);
    const env = { AGENTRIG_OPENAI_CHATGPT_TOKEN: JSON.stringify({ tokens: { access_token: "seed", refresh_token: "r" } }) };
    const store = new EnvSeededTokenStore(file, env);
    expect((await store.read())?.accessToken).toBe("seed");

    await store.write({ accessToken: "rotated", refreshToken: "r2" });
    expect(file.tokens?.accessToken).toBe("rotated");
    // file now wins over the env seed
    expect((await store.read())?.accessToken).toBe("rotated");
  });

  it("returns null when neither file nor env has tokens", async () => {
    expect(await new EnvSeededTokenStore(new MemoryStore(null), {}).read()).toBeNull();
  });
});

describe("OpenAIChatGPTAuth.getAccessToken", () => {
  it("derives the account id from the access-token JWT when not stored", async () => {
    let now = 1_500_000;
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 3600, "acct_from_jwt"), refreshToken: "r" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn: async () => new Response("{}"), now: () => now });
    expect((await auth.getAccessToken()).accountId).toBe("acct_from_jwt");
  });


  it("returns the stored token when it is not near expiry", async () => {
    let now = 2_000_000;
    let refreshes = 0;
    const fetchFn: typeof fetch = async () => {
      refreshes++;
      return new Response("{}", { status: 200 });
    };
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 3600), refreshToken: "r", accountId: "acct_1" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now });
    const got = await auth.getAccessToken();
    expect(got.accountId).toBe("acct_1");
    expect(refreshes).toBe(0);
  });

  it("refreshes a near-expiry token and persists the rotated refresh token", async () => {
    let now = 3_000_000;
    const fetchFn: typeof fetch = async (url, init) => {
      expect(String(url)).toContain("/oauth/token");
      expect(JSON.parse(String(init!.body)).grant_type).toBe("refresh_token");
      return new Response(
        JSON.stringify({ access_token: accessJwt(now / 1000 + 3600, "acct_2"), refresh_token: "r2-rotated", id_token: jwt({ chatgpt_account_id: "acct_2" }) }),
        { status: 200 },
      );
    };
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "r1", accountId: "acct_2" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now });
    const got = await auth.getAccessToken();

    expect(got.accountId).toBe("acct_2");
    expect(store.tokens?.refreshToken).toBe("r2-rotated"); // rotation persisted
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    let now = 4_000_000;
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: accessJwt(now / 1000 + 3600) }), { status: 200 });
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "keep-me" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now });
    await auth.getAccessToken();
    expect(store.tokens?.refreshToken).toBe("keep-me");
  });

  it("throws when not signed in", async () => {
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(null), fetchFn: async () => new Response("{}") });
    await expect(auth.getAccessToken()).rejects.toThrow(/not signed in/);
  });

  it("surfaces a refresh failure with a re-login hint", async () => {
    let now = 5_000_000;
    const fetchFn: typeof fetch = async () => new Response("nope", { status: 400 });
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "r" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now });
    await expect(auth.getAccessToken()).rejects.toThrow(/login openai-chatgpt/);
  });
});
