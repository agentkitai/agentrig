import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  fetchWithRetries,
  isQuotaExhaustion,
  parseRetryAfter,
  redactSecrets,
  type ModelEvent,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

const req = (): ModelRequest => ({ system: "s", messages: [], tools: [], maxTokens: 10 });
const instantSleep = async () => {};

function sequence(responses: Array<() => Response>): { fetchFn: typeof fetch; calls: () => number } {
  let n = 0;
  return {
    fetchFn: (async () => responses[Math.min(n++, responses.length - 1)]!()) as typeof fetch,
    calls: () => n,
  };
}

describe("fetchWithRetries", () => {
  it("retries rate-limit 429s and 5xx, then succeeds", async () => {
    const { fetchFn, calls } = sequence([
      () => new Response("rate limited", { status: 429 }),
      () => new Response("overloaded", { status: 529 }),
      () => new Response("ok", { status: 200 }),
    ]);
    const res = await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      sleep: instantSleep,
    });
    expect(res.status).toBe(200);
    expect(calls()).toBe(3);
  });

  it("fails immediately on quota-exhaustion 429s", async () => {
    const { fetchFn, calls } = sequence([
      () => new Response('{"error":{"type":"insufficient_quota","message":"You have no credits remaining."}}', { status: 429 }),
    ]);
    await expect(
      fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, { sleep: instantSleep }),
    ).rejects.toThrow(/HTTP 429.*insufficient_quota/);
    expect(calls()).toBe(1);
  });

  it("fails immediately on non-retryable statuses", async () => {
    const { fetchFn, calls } = sequence([() => new Response("bad key", { status: 401 })]);
    await expect(
      fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, { sleep: instantSleep }),
    ).rejects.toThrow(/HTTP 401/);
    expect(calls()).toBe(1);
  });

  it("gives up after maxRetries and names the attempt count", async () => {
    const { fetchFn, calls } = sequence([() => new Response("boom", { status: 500 })]);
    await expect(
      fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
        maxRetries: 2,
        sleep: instantSleep,
      }),
    ).rejects.toThrow(/HTTP 500 boom \(after 3 attempts\)/);
    expect(calls()).toBe(3);
  });

  it("retries network errors", async () => {
    let n = 0;
    const fetchFn = (async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const res = await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      sleep: instantSleep,
    });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it("honors Retry-After and exponential backoff for delays", async () => {
    const delays: number[] = [];
    const { fetchFn } = sequence([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      () => new Response("still busy", { status: 503 }),
      () => new Response("ok", { status: 200 }),
    ]);
    await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([7000, 200]); // Retry-After wins; then base * 2^attempt
  });

  it("abort during backoff rejects promptly", async () => {
    const ac = new AbortController();
    const { fetchFn } = sequence([() => new Response("busy", { status: 429 })]);
    const pending = fetchWithRetries(fetchFn, "t", "http://x", {}, ac.signal, { baseDelayMs: 60_000 });
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("provider integration", () => {
  it("a transient 529 no longer kills the stream", async () => {
    let n = 0;
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
    const fetchFn = (async () => {
      if (n++ === 0) return new Response("overloaded", { status: 529 });
      return new Response(sse, { status: 200 });
    }) as typeof fetch;
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "m",
      fetchFn,
      retry: { sleep: async () => {} },
    });
    const events: ModelEvent[] = [];
    for await (const e of provider.stream(req(), new AbortController().signal)) events.push(e);
    expect(n).toBe(2);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end_turn" });
  });
});

describe("isQuotaExhaustion", () => {
  it("does not misread a plain rate limit that merely links to a billing page", () => {
    const rateLimit = JSON.stringify({
      error: {
        message: "Rate limit reached for gpt-4o. Please see https://platform.openai.com/account/billing for details.",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
    expect(isQuotaExhaustion(rateLimit)).toBe(false);
  });

  it("detects real quota exhaustion by structured code and by phrase", () => {
    expect(isQuotaExhaustion(JSON.stringify({ error: { code: "insufficient_quota", message: "no credits" } }))).toBe(true);
    expect(isQuotaExhaustion(JSON.stringify({ error: { type: "insufficient_quota" } }))).toBe(true);
    expect(isQuotaExhaustion("You exceeded your current quota, please check your plan.")).toBe(true);
    expect(isQuotaExhaustion("Your credit balance is too low to access the API")).toBe(true);
  });

  it("a billing-linking rate limit is retried, not hard-failed", async () => {
    const body = JSON.stringify({ error: { message: "Rate limit reached, see /account/billing", code: "rate_limit_exceeded" } });
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return n === 1 ? new Response(body, { status: 429 }) : new Response("ok", { status: 200 });
    }) as typeof fetch;
    const res = await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      sleep: async () => {},
    });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });
});

describe("parseRetryAfter", () => {
  it("accepts delay-seconds and HTTP-date forms", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:30:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:00:00 GMT", now)).toBe(0); // past date clamps
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("garbage", now)).toBeNull();
  });

  it("honors an HTTP-date Retry-After in the backoff", async () => {
    const delays: number[] = [];
    const future = new Date(Date.now() + 12_000).toUTCString();
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return n === 1
        ? new Response("slow", { status: 503, headers: { "retry-after": future } })
        : new Response("ok", { status: 200 });
    }) as typeof fetch;
    await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays[0]).toBeGreaterThan(9000); // used the date, not the 100ms base
  });
});

describe("credential redaction in error messages", () => {
  it("strips bearer tokens, JWTs, api keys, and token JSON fields", () => {
    const dirty =
      'Authorization: Bearer sk-abcdefghijklmnop {"access_token":"eyJhbGciOi.eyJzdWIiOiJ4.sig","refresh_token":"rt-secret"}';
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("sk-abcdefghijklmnop");
    expect(clean).not.toContain("rt-secret");
    expect(clean).not.toContain("eyJzdWIiOiJ4");
    expect(clean).toContain("[redacted");
  });

  it("keeps a server-echoed credential out of the thrown error", async () => {
    const echoed = 'Unauthorized for Bearer eyJhbGciOi.eyJzdWIiOiJ4.sig';
    const fetchFn = (async () => new Response(echoed, { status: 403 })) as typeof fetch;
    const err = await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      sleep: async () => {},
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 403");
    expect((err as Error).message).not.toContain("eyJzdWIiOiJ4");
  });
});

describe("edge bot challenges are named, not dumped as markup", () => {
  it("reports a Cloudflare challenge instead of 500 chars of HTML", async () => {
    const html = "<!DOCTYPE html><html><head><title>Just a moment...</title>" + "<div>".repeat(200);
    const fetchFn = (async () =>
      new Response(html, {
        status: 403,
        headers: { "cf-mitigated": "challenge", server: "cloudflare", "cf-ray": "abc123", "content-type": "text/html" },
      })) as typeof fetch;
    const err = (await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      sleep: async () => {},
    }).catch((e: Error) => e)) as Error;

    expect(err.message).toContain("edge bot challenge");
    expect(err.message).toContain("cf-mitigated=challenge");
    expect(err.message).toContain("headless");
    expect(err.message).not.toContain("<div>"); // no markup wall
  });

  it("leaves ordinary API error bodies alone", async () => {
    const fetchFn = (async () =>
      new Response('{"error":{"message":"bad request"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const err = (await fetchWithRetries(fetchFn, "t", "http://x", {}, new AbortController().signal, {
      sleep: async () => {},
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("bad request");
    expect(err.message).not.toContain("edge bot challenge");
  });
});
