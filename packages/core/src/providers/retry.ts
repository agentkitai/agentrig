/**
 * Bounded retry for provider HTTP calls. The first live smoke test showed a plain rate-limit
 * 429 would kill a session on first contact; under real dogfooding load that's unacceptable.
 * Retries happen only before any stream bytes are consumed, so a retry is always a clean
 * re-request. Non-retryable failures (bad key, quota/billing exhaustion) throw immediately.
 */

export interface RetryPolicy {
  /** Additional attempts after the first (default 3). */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt, capped at 30s (default 1000). */
  baseDelayMs?: number;
  /** Injectable for tests; must reject with AbortError when the signal fires. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);
const MAX_DELAY_MS = 30_000;

/** A 429 that means "out of money" will never succeed on retry. */
function isQuotaExhaustion(body: string): boolean {
  return /insufficient_quota|credit_balance|billing|exceeded your current quota/i.test(body);
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      rej(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      res();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithRetries(
  fetchFn: typeof fetch,
  label: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  policy: RetryPolicy = {},
): Promise<Response> {
  const maxRetries = policy.maxRetries ?? 3;
  const baseDelayMs = policy.baseDelayMs ?? 1000;
  const sleep = policy.sleep ?? abortableSleep;

  for (let attempt = 0; ; attempt++) {
    const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal });
    } catch (err) {
      if (signal.aborted || attempt >= maxRetries) {
        if (signal.aborted || !(err instanceof Error)) throw err;
        throw new Error(`${label}: ${err.message}${suffix}`);
      }
      await sleep(Math.min(baseDelayMs * 2 ** attempt, MAX_DELAY_MS), signal);
      continue;
    }

    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    const retryable =
      RETRYABLE_STATUSES.has(res.status) && !(res.status === 429 && isQuotaExhaustion(body));
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 500)}${suffix}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
    await sleep(Math.min(delay, MAX_DELAY_MS), signal);
  }
}
