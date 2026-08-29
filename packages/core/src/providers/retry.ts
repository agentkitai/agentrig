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

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_DELAY_MS = 30_000;

/**
 * Strip anything that looks like a credential before a response body is interpolated into an
 * error message. Error messages reach the session JSONL and stderr, so a server that echoes a
 * bearer token (or a proxy that echoes the request) must not durably leak it.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, "[redacted-jwt]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted-key]")
    .replace(/("(?:access_token|refresh_token|id_token|api_key|authorization)"\s*:\s*")[^"]*/gi, "$1[redacted]");
}

/** Bounded, redacted response-body excerpt for an error message. */
export function errorDetail(body: string, max = 500): string {
  return redactSecrets(body).slice(0, max);
}

/**
 * "Out of money" 429s never succeed on retry, but a plain rate limit does — and rate-limit
 * bodies often link to a billing page, so a bare substring match would misclassify them.
 * Prefer the structured error code, and fall back only to phrases that can't appear incidentally.
 */
export function isQuotaExhaustion(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    const code = String(parsed.error?.code ?? "");
    const type = String(parsed.error?.type ?? "");
    if (code === "insufficient_quota" || type === "insufficient_quota") return true;
    if (code === "billing_hard_limit_reached" || type === "billing_hard_limit_reached") return true;
  } catch {
    // not JSON; fall through to phrase matching
  }
  return /exceeded your current quota|insufficient_quota|credit balance is too low|billing hard limit/i.test(body);
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

/** RFC 7231 allows delay-seconds or an HTTP-date; support both. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
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
      throw new Error(`${label}: HTTP ${res.status} ${errorDetail(body)}${suffix}`);
    }
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    const delay = retryAfter ?? baseDelayMs * 2 ** attempt;
    await sleep(Math.min(delay, MAX_DELAY_MS), signal);
  }
}
