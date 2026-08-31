import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  fetchWithRetries,
  isQuotaExhaustion,
  isTransientStreamError,
  parseRetryAfter,
  redactSecrets,
  RetriesExhaustedError,
  streamWithRetries,
  type ModelEvent,
  type ModelRequest,
  type StreamRetryInfo,
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

// ---------------------------------------------------------------- stream-level retry

describe("isTransientStreamError", () => {
  it("recognises the messages that killed real sessions, and network-level cuts", () => {
    // verbatim from the ChatGPT backend, delivered inside an HTTP 200 SSE stream
    expect(isTransientStreamError("openai-chatgpt stream error: Our servers are currently overloaded. Please try again later.")).toBe(true);
    expect(isTransientStreamError("anthropic stream error: overloaded_error: Overloaded")).toBe(true);
    expect(isTransientStreamError("fetch failed")).toBe(true);
    expect(isTransientStreamError("read ECONNRESET")).toBe(true);
  });

  it("never calls quota exhaustion transient, whatever the phrasing around it", () => {
    // "try again" appears in the message, but retrying an empty wallet burns attempts for nothing
    expect(isTransientStreamError("You have exceeded your current quota. Please try again later.")).toBe(false);
    expect(isTransientStreamError("HTTP 401 invalid api key")).toBe(false);
    expect(isTransientStreamError("model not found")).toBe(false);
  });

  it("is not steered by polite server prose inside a deterministic HTTP failure", () => {
    // server-controlled body text is interpolated into fetchWithRetries error messages; a 400 or
    // 403 whose page says "try again" is still deterministic and retrying it is pure waste
    expect(isTransientStreamError("anthropic: HTTP 400 invalid_request_error: tools.0 schema invalid, please fix and try again")).toBe(false);
    expect(isTransientStreamError("openai-chatgpt: HTTP 403 originator not allowed. If you believe this is an error, try again or contact support.")).toBe(false);
    expect(isTransientStreamError("anthropic: HTTP 413 request too large, reduce your prompt and try again")).toBe(false);
    // "terminated" only as undici's whole message (a mid-body connection cut), never as a substring
    expect(isTransientStreamError("terminated")).toBe(true);
    expect(isTransientStreamError("openai-chatgpt stream failed: response terminated by moderation")).toBe(false);
  });
});

describe("streamWithRetries", () => {
  const signal = () => new AbortController().signal;
  const collectAll = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
    const out: T[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  function failing(times: number, message: string, events: string[] = ["a", "b"]) {
    let calls = 0;
    return {
      open: async function* (): AsyncIterable<string> {
        calls += 1;
        if (calls <= times) throw new Error(message);
        yield* events;
      },
      calls: () => calls,
    };
  }

  it("re-requests a transient failure and delivers the clean attempt in full", async () => {
    const f = failing(2, "stream error: Our servers are currently overloaded.");
    const delays: number[] = [];
    const notices: StreamRetryInfo[] = [];
    const out = await collectAll(
      streamWithRetries(f.open, signal(), { sleep: async (ms) => void delays.push(ms) }, (i) => notices.push(i)),
    );
    expect(out).toEqual(["a", "b"]);
    expect(f.calls()).toBe(3);
    // exponential: 1s then 2s
    expect(delays).toEqual([1000, 2000]);
    expect(notices.map((n) => `${n.attempt}/${n.maxAttempts}`)).toEqual(["1/4", "2/4"]);
    expect(notices[0]!.reason).toContain("overloaded");
  });

  it("NEVER re-requests once an event has been yielded — a retry would replay the prefix", async () => {
    let calls = 0;
    const open = async function* (): AsyncIterable<string> {
      calls += 1;
      yield "partial reply";
      throw new Error("stream error: overloaded");
    };
    const seen: string[] = [];
    await expect(async () => {
      for await (const e of streamWithRetries(open, signal(), { sleep: async () => {} })) seen.push(e);
    }).rejects.toThrow(/overloaded/);
    expect(calls).toBe(1);
    expect(seen).toEqual(["partial reply"]);
  });

  it("throws a non-transient failure immediately", async () => {
    const f = failing(1, "HTTP 401 invalid key");
    await expect(collectAll(streamWithRetries(f.open, signal(), { sleep: async () => {} }))).rejects.toThrow(/401/);
    expect(f.calls()).toBe(1);
  });

  it("does not mistake quota exhaustion for a transient overload", async () => {
    const f = failing(1, "You have exceeded your current quota. Please try again later.");
    await expect(collectAll(streamWithRetries(f.open, signal(), { sleep: async () => {} }))).rejects.toThrow(/quota/);
    expect(f.calls()).toBe(1);
  });

  it("gives up after maxRetries with the last error", async () => {
    const f = failing(99, "temporarily unavailable");
    await expect(
      collectAll(streamWithRetries(f.open, signal(), { maxRetries: 2, sleep: async () => {} })),
    ).rejects.toThrow(/temporarily unavailable/);
    expect(f.calls()).toBe(3);
  });

  it("yields a marker for each retry without spending the replay guard on it", async () => {
    // Two consecutive transient failures: each must produce a marker AND still be allowed to
    // retry. If the marker flipped `yielded`, the first retry's own marker would forbid the
    // second retry — the guard must count content, not bookkeeping.
    const f = failing(2, "stream error: overloaded");
    const out = await collectAll(
      streamWithRetries(f.open, signal(), { sleep: async () => {} }, undefined, (info) => `retry#${info.attempt}`),
    );
    expect(out).toEqual(["retry#1", "retry#2", "a", "b"]);
    expect(f.calls()).toBe(3);
  });

  it("refuses a failure the HTTP layer already retried to exhaustion", async () => {
    // without the typed refusal, both budgets were spent on one failure: 16 fetches, ~35s
    const f = {
      calls: 0,
      open: async function* (this: void): AsyncIterable<string> {
        f.calls += 1;
        throw new RetriesExhaustedError("anthropic: fetch failed (after 4 attempts)");
        yield "never";
      },
    };
    await expect(collectAll(streamWithRetries(f.open, signal(), { sleep: async () => {} }))).rejects.toThrow(
      /after 4 attempts/,
    );
    expect(f.calls).toBe(1);
  });

  it("stops retrying when the caller aborts", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const open = async function* (): AsyncIterable<string> {
      calls += 1;
      ctl.abort();
      throw new Error("overloaded");
      yield "never";
    };
    await expect(collectAll(streamWithRetries(open, ctl.signal, { sleep: async () => {} }))).rejects.toThrow(
      /overloaded/,
    );
    expect(calls).toBe(1);
  });
});

describe("retry layering through the public provider API", () => {
  it("spends ONE retry budget on a persistent network failure, not four stream x four HTTP", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "k", model: "m", fetchFn, retry: { sleep: instantSleep } });
    await expect(async () => {
      for await (const e of provider.stream(req(), new AbortController().signal)) void e;
    }).rejects.toThrow(/fetch failed \(after 4 attempts\)/);
    expect(calls).toBe(4); // 1 + 3 HTTP retries; the stream layer must not multiply it to 16
  });

  it("spends ONE retry budget on a persistent overloaded 529 too", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response('{"error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 });
    }) as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "k", model: "m", fetchFn, retry: { sleep: instantSleep } });
    await expect(async () => {
      for await (const e of provider.stream(req(), new AbortController().signal)) void e;
    }).rejects.toThrow(/HTTP 529/);
    expect(calls).toBe(4);
  });
});
