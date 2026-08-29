import { describe, expect, it } from "vitest";
import { AnthropicProvider, fetchWithRetries, type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";

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
