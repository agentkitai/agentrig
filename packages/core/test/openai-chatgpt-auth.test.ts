import { createHash } from "node:crypto";
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

/** Drives the loopback listener the way a browser would, without one. */
async function visit(url: string): Promise<number> {
  const res = await fetch(url, { redirect: "manual" });
  await res.text();
  return res.status;
}

describe("OpenAIChatGPTAuth browser login", () => {
  it("exchanges the code for tokens and persists them", async () => {
    const bodies: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      bodies.push(String(init!.body));
      expect(String(url)).toMatch(/\/oauth\/token$/);
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r" }), { status: 200 });
    };
    const store = new MemoryStore();
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, retry: { sleep: async () => {} } });
    const login = await auth.startLoopbackLogin({ port: 0 });

    // the authorize URL is what the BROWSER opens; this process never fetches it, because that
    // is the request Cloudflare challenges
    const authorize = new URL(login.url);
    expect(authorize.origin + authorize.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(login.redirectUri);

    const state = authorize.searchParams.get("state")!;
    const done = login.complete();
    expect(await visit(`${login.redirectUri}?code=the-code&state=${state}`)).toBe(200);
    expect(await done).toMatchObject({ accessToken: "a", refreshToken: "r" });
    expect(store.tokens).toMatchObject({ accessToken: "a" });

    const body = new URLSearchParams(bodies[0]!);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe(login.redirectUri);
    // the verifier is what proves the same client started the flow
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("proves possession: the verifier hashes to the challenge it advertised", async () => {
    const bodies: string[] = [];
    const fetchFn: typeof fetch = async (_u, init) => {
      bodies.push(String(init!.body));
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r" }), { status: 200 });
    };
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(), fetchFn, retry: { sleep: async () => {} } });
    const login = await auth.startLoopbackLogin({ port: 0 });
    const params = new URL(login.url).searchParams;
    const done = login.complete();
    await visit(`${login.redirectUri}?code=c&state=${params.get("state")}`);
    await done;

    const verifier = new URLSearchParams(bodies[0]!).get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(params.get("code_challenge"));
  });

  it("refuses a redirect whose state is not the one it issued", async () => {
    let exchanged = 0;
    const fetchFn: typeof fetch = async () => {
      exchanged += 1;
      return new Response("{}", { status: 200 });
    };
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(), fetchFn, retry: { sleep: async () => {} } });
    const login = await auth.startLoopbackLogin({ port: 0 });
    // the assertion is attached before the redirect arrives: a rejection with no handler yet is
    // an unhandled rejection, which vitest reports as an error even when the test passes
    const done = expect(login.complete()).rejects.toThrow(/state did not match/);
    expect(await visit(`${login.redirectUri}?code=stolen&state=not-ours`)).toBe(400);
    await done;
    // the point of the check: a code we did not ask for is never exchanged
    expect(exchanged).toBe(0);
  });

  it("reports the provider's own refusal rather than waiting for a code", async () => {
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(), retry: { sleep: async () => {} } });
    const login = await auth.startLoopbackLogin({ port: 0 });
    const done = expect(login.complete()).rejects.toThrow(/User said no/);
    await visit(`${login.redirectUri}?error=access_denied&error_description=User%20said%20no`);
    await done;
  });

  it("surfaces a rejected exchange with the status, redacted", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(), fetchFn, retry: { sleep: async () => {} } });
    const login = await auth.startLoopbackLogin({ port: 0 });
    const state = new URL(login.url).searchParams.get("state")!;
    const done = expect(login.complete()).rejects.toThrow(/HTTP 400/);
    await visit(`${login.redirectUri}?code=c&state=${state}`);
    await done;
  });

  it("cancel stops the listener, so a declined login leaves nothing running", async () => {
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(), retry: { sleep: async () => {} } });
    const login = await auth.startLoopbackLogin({ port: 0 });
    login.cancel();
    await expect(fetch(login.redirectUri)).rejects.toThrow();
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
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    const got = await auth.getAccessToken();
    expect(got.accountId).toBe("acct_1");
    expect(refreshes).toBe(0);
  });

  it("refreshes a near-expiry token and persists the rotated refresh token", async () => {
    let now = 3_000_000;
    const fetchFn: typeof fetch = async (url, init) => {
      expect(String(url)).toContain("/oauth/token");
      expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
      const form = new URLSearchParams(String(init!.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("r1");
      return new Response(
        JSON.stringify({ access_token: accessJwt(now / 1000 + 3600, "acct_2"), refresh_token: "r2-rotated", id_token: jwt({ chatgpt_account_id: "acct_2" }) }),
        { status: 200 },
      );
    };
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "r1", accountId: "acct_2" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    const got = await auth.getAccessToken();

    expect(got.accountId).toBe("acct_2");
    expect(store.tokens?.refreshToken).toBe("r2-rotated"); // rotation persisted
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    let now = 4_000_000;
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: accessJwt(now / 1000 + 3600) }), { status: 200 });
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "keep-me" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    await auth.getAccessToken();
    expect(store.tokens?.refreshToken).toBe("keep-me");
  });

  it("throws when not signed in", async () => {
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore(null), fetchFn: async () => new Response("{}"), retry: { sleep: async () => {} } });
    await expect(auth.getAccessToken()).rejects.toThrow(/not signed in/);
  });

  it("surfaces a refresh failure with a re-login hint", async () => {
    let now = 5_000_000;
    const fetchFn: typeof fetch = async () => new Response("nope", { status: 400 });
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "r" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    await expect(auth.getAccessToken()).rejects.toThrow(/login openai-chatgpt/);
  });
});

describe("refresh-response validation (drift must not corrupt the store)", () => {
  it("rejects a 200 whose shape we don't recognise, leaving stored tokens untouched", async () => {
    let now = 6_000_000;
    const good: ChatGPTTokens = { accessToken: accessJwt(now / 1000 + 60), refreshToken: "GOOD-REFRESH" };
    const store = new MemoryStore({ ...good });
    // field-name drift: the server returns camelCase, which we don't read
    const fetchFn: typeof fetch = async () => new Response(JSON.stringify({ accessToken: "new" }), { status: 200 });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });

    await expect(auth.getAccessToken()).rejects.toThrow(/carried no access_token/);
    expect(store.tokens).toEqual(good); // credential store intact
  });

  it("rejects a 200 with an unreadable body without touching the store", async () => {
    let now = 6_500_000;
    const good: ChatGPTTokens = { accessToken: accessJwt(now / 1000 + 60), refreshToken: "GOOD" };
    const store = new MemoryStore({ ...good });
    const fetchFn: typeof fetch = async () => new Response("<html>proxy</html>", { status: 200 });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    await expect(auth.getAccessToken()).rejects.toThrow(/unreadable body/);
    expect(store.tokens).toEqual(good);
  });

  it("distinguishes a rejected grant from a transient auth outage", async () => {
    let now = 7_000_000;
    const store = () => new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "r" });
    const rejecting: typeof fetch = async () => new Response("bad grant", { status: 400 });
    await expect(
      new OpenAIChatGPTAuth({ store: store(), fetchFn: rejecting, now: () => now, retry: { sleep: async () => {} } }).getAccessToken(),
    ).rejects.toThrow(/re-run `agentrig login openai-chatgpt`/);

    const flaky: typeof fetch = async () => new Response("gateway", { status: 503 });
    const err = await new OpenAIChatGPTAuth({ store: store(), fetchFn: flaky, now: () => now, retry: { sleep: async () => {} } })
      .getAccessToken()
      .catch((e: Error) => e);
    expect((err as Error).name).toBe("TransientAuthError");
    expect((err as Error).message).not.toMatch(/re-run/); // credentials are fine; don't misdirect
  });

  it("retries a transient refresh failure and then succeeds", async () => {
    let now = 7_500_000;
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("blip", { status: 503 });
      return new Response(JSON.stringify({ access_token: accessJwt(now / 1000 + 3600), refresh_token: "r2" }), { status: 200 });
    };
    const store = new MemoryStore({ accessToken: accessJwt(now / 1000 + 60), refreshToken: "r1" });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    await auth.getAccessToken();
    expect(calls).toBe(2);
    expect(store.tokens?.refreshToken).toBe("r2");
  });
});

describe("opaque (non-JWT) access tokens", () => {
  it("refreshes on age when there is no readable expiry", async () => {
    let now = 8_000_000;
    let refreshes = 0;
    const fetchFn: typeof fetch = async () => {
      refreshes += 1;
      return new Response(JSON.stringify({ access_token: "opaque-2", refresh_token: "r" }), { status: 200 });
    };
    // lastRefresh is an hour old and the token carries no exp -> must refresh
    const store = new MemoryStore({ accessToken: "opaque-1", refreshToken: "r", lastRefresh: now - 60 * 60_000 });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    expect((await auth.getAccessToken()).accessToken).toBe("opaque-2");
    expect(refreshes).toBe(1);
  });

  it("does not refresh a recently minted opaque token", async () => {
    let now = 8_500_000;
    let refreshes = 0;
    const fetchFn: typeof fetch = async () => {
      refreshes += 1;
      return new Response("{}", { status: 200 });
    };
    const store = new MemoryStore({ accessToken: "opaque", refreshToken: "r", lastRefresh: now - 60_000 });
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now, retry: { sleep: async () => {} } });
    await auth.getAccessToken();
    expect(refreshes).toBe(0);
  });
});

describe("env seed validation", () => {
  it("rejects a bundle with no usable refresh token in either shape", () => {
    expect(tokensFromEnvValue(JSON.stringify({ tokens: { access_token: "a" } }))).toBeNull();
    expect(tokensFromEnvValue(JSON.stringify({ accessToken: "a", refreshToken: "" }))).toBeNull();
    expect(tokensFromEnvValue(JSON.stringify({ tokens: null, access_token: "a", refresh_token: "r" }))).toMatchObject({
      accessToken: "a",
    });
    expect(tokensFromEnvValue(JSON.stringify([1, 2]))).toBeNull();
  });
});
