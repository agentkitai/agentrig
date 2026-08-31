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
 * An edge bot-challenge (Cloudflare Turnstile and friends) answers with an HTML interstitial,
 * not an API error. Dumping 500 chars of markup tells an operator nothing, so name the actual
 * condition: these need a real browser and will never succeed from a headless container.
 */
export function describeEdgeChallenge(res: Response, body: string): string | null {
  const mitigated = res.headers.get("cf-mitigated");
  const server = res.headers.get("server") ?? "";
  const contentType = res.headers.get("content-type") ?? "";
  const looksHtml = contentType.includes("text/html") || /^\s*<(!doctype|html)/i.test(body);
  if (mitigated === null && !(looksHtml && /cloudflare/i.test(server))) return null;
  const ray = res.headers.get("cf-ray");
  return (
    "edge bot challenge, not an API error " +
    `(server=${server || "unknown"}${mitigated === null ? "" : `, cf-mitigated=${mitigated}`}` +
    `${ray === null ? "" : `, cf-ray=${ray}`}). ` +
    "This endpoint requires an interactive browser and cannot be completed from a headless environment."
  );
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

/** What a stream-level retry looked like, for a UI that wants to say "retrying in 2s". */
export interface StreamRetryInfo {
  /** 1-based: the attempt that just failed. */
  attempt: number;
  /** Total attempts that will be made before giving up. */
  maxAttempts: number;
  delayMs: number;
  /** The failed attempt's error message, already redacted by the thrower. */
  reason: string;
}

/**
 * Thrown by `fetchWithRetries` when it retried a transient failure and ran out of attempts.
 * The type is the contract that stops retry stacking: `streamWithRetries` refuses to retry it,
 * because the HTTP layer already spent the full budget on this exact failure — without this,
 * a persistent outage cost 16 fetches and ~35 seconds (4 stream attempts × 4 HTTP attempts)
 * against a backend that was already saying it is overloaded.
 */
export class RetriesExhaustedError extends Error {}

/**
 * Whether an error thrown MID-STREAM is worth a clean re-request. This is a different question
 * from HTTP-status retryability: the ChatGPT backend in particular answers 200 and then delivers
 * "Our servers are currently overloaded. Please try again later." as an SSE error event, which
 * sailed past `fetchWithRetries` and killed two real dogfood sessions at turns 43 and 46.
 * Quota exhaustion is never transient, whatever the phrasing around it.
 */
export function isTransientStreamError(message: string): boolean {
  if (isQuotaExhaustion(message)) return false;
  // A message carrying an HTTP status label came from fetchWithRetries, which already applied
  // status-based policy. A non-retryable status is deterministic no matter how politely the
  // body says otherwise — "please fix and try again" inside a 400, or a 403 gateway page's
  // "try again or contact support", is server-controlled text and must not drive retries.
  const status = message.match(/HTTP (\d{3})/);
  if (status !== null && !RETRYABLE_STATUSES.has(Number(status[1]))) return false;
  // undici reports a connection cut mid-body as exactly "terminated"; matched whole, because as
  // a bare substring it also matched deterministic messages like "terminated by moderation"
  if (/^terminated$/.test(message)) return true;
  return /overloaded|rate limit|too many requests|temporarily unavailable|server_error|internal (server )?error|ECONNRESET|ETIMEDOUT|socket hang up|premature close|fetch failed|network error/i.test(
    message,
  );
}

/**
 * Runs `open()` and re-runs it on a transient failure — but ONLY while nothing has been yielded
 * downstream. Once the consumer has seen an event, a retry would replay the prefix (duplicated
 * text deltas, double tool calls), so a later failure propagates instead. That guard is what
 * makes this safe to wrap around a whole provider stream: an overload error arrives before any
 * content, so it retries; a genuine mid-reply disconnect does not pretend to be recoverable.
 *
 * Layering: `fetchWithRetries` (inside `open`) covers failures BEFORE a 200 arrives; this covers
 * failures inside the stream that follows. A failure the HTTP layer already retried to
 * exhaustion arrives as `RetriesExhaustedError` and is refused here, so the two layers never
 * spend both budgets on the same failure.
 */
export async function* streamWithRetries<T>(
  open: () => AsyncIterable<T>,
  signal: AbortSignal,
  policy: RetryPolicy = {},
  onRetry?: (info: StreamRetryInfo) => void,
  /**
   * Makes a retry visible downstream as an event of the stream's own type, so a consumer that
   * only sees events (the agent loop) can record it. A marker is informational, NOT content:
   * it is yielded from the catch path, outside the loop that flips the per-attempt `yielded`
   * guard, so a marker never forbids the retry that follows it.
   */
  toEvent?: (info: StreamRetryInfo) => T,
): AsyncIterable<T> {
  const maxRetries = policy.maxRetries ?? 3;
  const baseDelayMs = policy.baseDelayMs ?? 1000;
  const sleep = policy.sleep ?? abortableSleep;

  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      for await (const event of open()) {
        yielded = true;
        yield event;
      }
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof RetriesExhaustedError) throw err;
      if (yielded || signal.aborted || attempt >= maxRetries || !isTransientStreamError(reason)) throw err;
      const info: StreamRetryInfo = { attempt: attempt + 1, maxAttempts: maxRetries + 1, delayMs: Math.min(baseDelayMs * 2 ** attempt, MAX_DELAY_MS), reason };
      onRetry?.(info);
      if (toEvent !== undefined) yield toEvent(info);
      await sleep(info.delayMs, signal);
    }
  }
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
        // typed: the retry budget was spent on this failure, so no outer layer retries it again
        throw new RetriesExhaustedError(`${label}: ${err.message}${suffix}`);
      }
      await sleep(Math.min(baseDelayMs * 2 ** attempt, MAX_DELAY_MS), signal);
      continue;
    }

    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    const retryable =
      RETRYABLE_STATUSES.has(res.status) && !(res.status === 429 && isQuotaExhaustion(body));
    if (!retryable || attempt >= maxRetries) {
      const challenge = describeEdgeChallenge(res, body);
      const message = `${label}: HTTP ${res.status} ${challenge ?? errorDetail(body)}${suffix}`;
      // a retryable status that ran out of attempts is typed so the stream layer stands down;
      // a non-retryable status throws plain — it never consumed retry budget here, and the
      // status guard in isTransientStreamError keeps it non-transient anyway
      throw retryable ? new RetriesExhaustedError(message) : new Error(message);
    }
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    const delay = retryAfter ?? baseDelayMs * 2 ** attempt;
    await sleep(Math.min(delay, MAX_DELAY_MS), signal);
  }
}
