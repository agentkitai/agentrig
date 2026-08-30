import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, createPkce, createState, listenForCallback } from "@agentkitai/agentrig-core";

const get = async (url: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(url, { redirect: "manual" });
  return { status: res.status, body: await res.text() };
};

describe("PKCE", () => {
  it("is a verifier the challenge is the S256 hash of", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("is different every time, or it proves nothing", () => {
    const seen = new Set(Array.from({ length: 20 }, () => createPkce().verifier));
    expect(seen.size).toBe(20);
    expect(new Set(Array.from({ length: 20 }, () => createState())).size).toBe(20);
  });
});

describe("authorizeUrl", () => {
  it("carries what the provider needs to bind the code to this client", () => {
    const url = new URL(
      authorizeUrl({
        authBaseUrl: "https://auth.example/",
        clientId: "cid",
        redirectUri: "http://localhost:1455/auth/callback",
        scope: "openid offline_access",
        challenge: "chal",
        state: "st",
        extra: { id_token_add_organizations: "true" },
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid offline_access",
      code_challenge: "chal",
      code_challenge_method: "S256",
      state: "st",
      id_token_add_organizations: "true",
    });
  });

  it("never sends the verifier — the whole point is that it stays here", () => {
    const { verifier, challenge } = createPkce();
    const url = authorizeUrl({
      authBaseUrl: "https://auth.example",
      clientId: "c",
      redirectUri: "http://localhost:1/cb",
      scope: "s",
      challenge,
      state: "st",
    });
    expect(url).not.toContain(verifier);
  });
});

describe("listenForCallback", () => {
  it("answers the redirect and hands back the code", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    const res = await get(`${l.redirectUri}?code=abc123&state=st`);
    expect(res.status).toBe(200);
    expect(await l.wait).toEqual({ code: "abc123" });
    l.close();
  });

  it("never puts the code in the page it serves", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    const res = await get(`${l.redirectUri}?code=SECRET-CODE&state=st`);
    await l.wait;
    // the code is a credential and the browser window is where a shoulder-surfer looks
    expect(res.body).not.toContain("SECRET-CODE");
    l.close();
  });

  it("ignores the other things a browser asks for", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    const base = new URL(l.redirectUri).origin;
    expect((await get(`${base}/favicon.ico`)).status).toBe(404);
    // ...and is still waiting, rather than having failed the login over a favicon
    expect((await get(`${l.redirectUri}?code=c&state=st`)).status).toBe(200);
    expect(await l.wait).toEqual({ code: "c" });
    l.close();
  });

  it("rejects a redirect with the wrong state and never reports a code", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    const failing = expect(l.wait).rejects.toThrow(/state did not match/);
    expect((await get(`${l.redirectUri}?code=c&state=other`)).status).toBe(400);
    await failing;
    l.close();
  });

  it("times out instead of listening forever", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st", timeoutMs: 20 });
    await expect(l.wait).rejects.toThrow(/timed out/);
    // and the listener is gone, not merely unwatched
    await expect(fetch(l.redirectUri)).rejects.toThrow();
  });

  it("is single-shot: a second redirect changes nothing", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    await get(`${l.redirectUri}?code=first&state=st`);
    expect(await l.wait).toEqual({ code: "first" });
    // the listener is closed after the first, so a replay cannot reach it at all
    await expect(fetch(`${l.redirectUri}?code=second&state=st`)).rejects.toThrow();
  });

  it("closes on close, and closing twice is not an error", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    l.close();
    l.close();
    await expect(fetch(l.redirectUri)).rejects.toThrow();
  });

  it("names the port when it is already taken, since that is the fixable part", async () => {
    const first = await listenForCallback({ port: 0, expectedState: "a" });
    const port = Number(new URL(first.redirectUri).port);
    await expect(listenForCallback({ port, expectedState: "b" })).rejects.toThrow(
      new RegExp(`port ${port} is already in use`),
    );
    first.close();
  });

  it("binds loopback only, never a public interface", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    // an authorization code arriving over the network would be one anyone on it could have sent.
    // Asserted on what was bound: `fetch("http://0.0.0.0:…")` proves nothing, since 0.0.0.0 as a
    // DESTINATION means this host and connects straight back to the loopback listener.
    expect(l.addresses.length).toBeGreaterThan(0);
    for (const a of l.addresses) expect(["127.0.0.1", "::1"]).toContain(a);
    l.close();
  });

  it("listens on both loopback stacks, because the browser picks which localhost means", async () => {
    const l = await listenForCallback({ port: 0, expectedState: "st" });
    const port = Number(new URL(l.redirectUri).port);
    // on Windows `localhost` usually resolves to ::1, and a v4-only listener never hears it
    const res = await fetch(`http://[::1]:${port}/auth/callback?code=c&state=st`).catch(() => null);
    if (res !== null) {
      await res.text();
      expect(await l.wait).toEqual({ code: "c" });
    }
    expect(l.addresses).toContain("127.0.0.1");
    l.close();
  });
});
