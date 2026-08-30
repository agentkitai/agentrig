import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorDetail, fetchWithRetries, type RetryPolicy } from "./retry.js";

/**
 * Token lifecycle for the experimental `openai-chatgpt` provider (PLAN §2.9): the "Sign in with
 * ChatGPT" device-code OAuth flow that OpenAI's Codex CLI uses, so an AgentRig run can bill
 * against a ChatGPT Plus/Pro subscription instead of a metered API key.
 *
 * These constants and the request shapes are read from the Apache-2.0 openai/codex source. They
 * talk to undocumented OpenAI endpoints and are expected to drift; this whole provider is
 * experimental and opt-in, never core auth. Because drift is expected, every server response is
 * validated before it is allowed to overwrite a stored credential — a malformed 200 must fail
 * loudly, never corrupt the store.
 */

/** Public OAuth client id Codex ships (not a secret). */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const OAUTH_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh once the access token is within this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;
/** Fallback for an opaque (non-JWT) access token, which carries no readable expiry. */
const OPAQUE_TOKEN_MAX_AGE_MS = 45 * 60_000;

export const ChatGPTTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string(),
  idToken: z.string().optional(),
  accountId: z.string().optional(),
  lastRefresh: z.number().int().optional(),
});
export type ChatGPTTokens = z.infer<typeof ChatGPTTokens>;

export interface TokenStore {
  read(): Promise<ChatGPTTokens | null>;
  write(tokens: ChatGPTTokens): Promise<void>;
}

/** Default location of the persisted token bundle; override with AGENTRIG_OPENAI_CHATGPT_AUTH. */
export function defaultAuthPath(): string {
  return process.env.AGENTRIG_OPENAI_CHATGPT_AUTH ?? join(homedir(), ".agentrig", "openai-chatgpt-auth.json");
}

/** Env var carrying a token bundle so ephemeral cloud sessions can auth without re-login. */
export const TOKEN_ENV_VAR = "AGENTRIG_OPENAI_CHATGPT_TOKEN";

/**
 * Parse a token bundle from an env-var string. Accepts AgentRig's own shape
 * (`{ accessToken, refreshToken, ... }`) and Codex's `auth.json` shape
 * (`{ tokens: { access_token, refresh_token, id_token, account_id } }`), so a user who is
 * already logged into Codex can paste `~/.codex/auth.json` directly.
 *
 * A bundle without a usable refresh token is rejected: it would authenticate until the access
 * token expires and then fail with a misleading error, which is worse than refusing it up front.
 */
export function tokensFromEnvValue(raw: string): ChatGPTTokens | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.accessToken === "string") {
    const parsed = ChatGPTTokens.safeParse(o);
    return parsed.success && parsed.data.refreshToken !== "" ? parsed.data : null;
  }
  const nested = o.tokens;
  const t = (typeof nested === "object" && nested !== null && !Array.isArray(nested) ? nested : o) as Record<
    string,
    unknown
  >;
  if (typeof t.access_token !== "string" || t.access_token === "") return null;
  if (typeof t.refresh_token !== "string" || t.refresh_token === "") return null;
  const tokens: ChatGPTTokens = { accessToken: t.access_token, refreshToken: t.refresh_token };
  if (typeof t.id_token === "string") tokens.idToken = t.id_token;
  if (typeof t.account_id === "string") tokens.accountId = t.account_id;
  return tokens;
}

/** Thrown when the stored token file exists but cannot be parsed. */
export class CorruptTokenFileError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(
      `openai-chatgpt: token file ${path} is unreadable (${cause instanceof Error ? cause.message : String(cause)}); ` +
        "delete it and seed a credential again (see the openai-chatgpt notes in docs/STATUS.md)",
    );
    this.name = "CorruptTokenFileError";
  }
}

/**
 * Atomic JSON token store. The temp file is created with O_EXCL under a random name so it can
 * never follow a pre-existing symlink or inherit a loosened mode, and it is removed if the
 * rename fails rather than left on disk holding a live credential.
 */
export interface FileTokenStoreOptions {
  /** Defaults to `process.platform`. Injected so the Windows path is testable off Windows. */
  platform?: NodeJS.Platform;
  /** Defaults to an `icacls` call. Injected for the same reason. */
  restrict?: (path: string) => Promise<void>;
  warn?: (message: string) => void;
}

export class FileTokenStore implements TokenStore {
  private readonly isWindows: boolean;
  private readonly restrict: (path: string) => Promise<void>;
  private readonly warn: (message: string) => void;
  private warnedRestrict = false;

  constructor(
    private readonly path: string = defaultAuthPath(),
    opts: FileTokenStoreOptions = {},
  ) {
    this.isWindows = (opts.platform ?? process.platform) === "win32";
    this.restrict = opts.restrict ?? restrictToOwnerWindows;
    this.warn = opts.warn ?? ((m) => console.error(m));
  }

  async read(): Promise<ChatGPTTokens | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    // the same reader as the env seed: a Codex `~/.codex/auth.json` copied here is the obvious
    // move once the device-code login turns out to be unusable, and it failed with a "corrupt
    // file" error that named neither the real problem nor the fix
    const tokens = tokensFromEnvValue(text);
    if (tokens !== null) return tokens;
    throw new CorruptTokenFileError(this.path, new Error("no usable access/refresh token pair"));
  }

  async write(tokens: ChatGPTTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      // "wx" is O_CREAT|O_EXCL: refuses an existing path, so it cannot follow a planted symlink
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(ChatGPTTokens.parse(tokens)), "utf8");
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      await rename(tmp, this.path);
      // `chmod(0o600)` only toggles the read-only bit on Windows — it does not keep another
      // account out. Tighten the ACL there instead, best-effort: a credential that could not be
      // locked down is still a credential the user needs, so this warns rather than failing.
      if (this.isWindows) {
        try {
          await this.restrict(this.path);
        } catch (err) {
          if (!this.warnedRestrict) {
            this.warnedRestrict = true;
            this.warn(
              `openai-chatgpt: could not restrict ${this.path} to your account ` +
                `(${(err as Error).message}); on a shared machine, run: ` +
                `icacls "${this.path}" /inheritance:r /grant:r "%USERNAME%":F`,
            );
          }
        }
      }
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * Reads the file store first (the live, rotated state within a session), falling back to a
 * token bundle in the environment (`AGENTRIG_OPENAI_CHATGPT_TOKEN`) so a fresh cloud container
 * can auth from a one-time seed. Writes (refresh rotation) always go to the writable file.
 *
 * A corrupt file falls through to the env seed rather than bricking the provider — recovering
 * from a damaged store is exactly what the seed exists for.
 */
export class EnvSeededTokenStore implements TokenStore {
  private warned = false;

  constructor(
    private readonly file: TokenStore = new FileTokenStore(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly envVar: string = TOKEN_ENV_VAR,
    private readonly warn: (message: string) => void = (m) => console.error(m),
  ) {}

  private seeded(): ChatGPTTokens | null {
    const raw = this.env[this.envVar];
    return raw ? tokensFromEnvValue(raw) : null;
  }

  async read(): Promise<ChatGPTTokens | null> {
    try {
      const fromFile = await this.file.read();
      if (fromFile !== null) return fromFile;
    } catch (err) {
      const seed = this.seeded();
      if (seed === null) throw err;
      if (!this.warned) {
        this.warned = true;
        this.warn(`${(err as Error).message}\nFalling back to ${this.envVar}.`);
      }
      return seed;
    }
    return this.seeded();
  }

  async write(tokens: ChatGPTTokens): Promise<void> {
    await this.file.write(tokens);
  }
}

/** Decode a JWT's payload claims without verifying the signature (we read our own token). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined;
  const claims = decodeJwtClaims(idToken);
  const id = claims?.["chatgpt_account_id"] ?? claims?.["account_id"];
  return typeof id === "string" ? id : undefined;
}

/** Access-token expiry in ms epoch from its `exp` claim, or null if unreadable. */
function accessTokenExpiry(accessToken: string): number | null {
  const exp = decodeJwtClaims(accessToken)?.["exp"];
  return typeof exp === "number" ? exp * 1000 : null;
}

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  /** Resolves once the user authorizes; rejects on timeout/denial. Persists the tokens. */
  complete(): Promise<ChatGPTTokens>;
}

export interface OpenAIChatGPTAuthOptions {
  store?: TokenStore;
  clientId?: string;
  authBaseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Injectable for tests so device-code polling doesn't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff for transient failures reaching the auth host. */
  retry?: RetryPolicy;
}

/** A transient failure reaching the auth host — the stored credentials are still fine. */
export class TransientAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientAuthError";
  }
}

/**
 * Owns the ChatGPT OAuth tokens: device-code login, and access-token vending with proactive
 * (and 401-forced) refresh. Refresh responses can rotate the refresh token, so every refresh is
 * persisted back to the store — a static token snapshot would go stale after the first refresh.
 */
export class OpenAIChatGPTAuth {
  private readonly store: TokenStore;
  private readonly clientId: string;
  private readonly authBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retry: RetryPolicy;
  private inFlight: Promise<ChatGPTTokens> | null = null;

  constructor(opts: OpenAIChatGPTAuthOptions = {}) {
    this.store = opts.store ?? new EnvSeededTokenStore();
    this.clientId = opts.clientId ?? CHATGPT_CLIENT_ID;
    this.authBaseUrl = (opts.authBaseUrl ?? AUTH_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retry = opts.retry ?? {};
  }

  /** The stored token bundle, for exporting to seed another environment; null if not signed in. */
  async exportTokens(): Promise<ChatGPTTokens | null> {
    return this.store.read();
  }

  /** Start the device-code flow: returns the code/URL to show the user plus a completion poller. */
  async startDeviceLogin(): Promise<DeviceLogin> {
    const res = await fetchWithRetries(
      this.fetchFn,
      "openai-chatgpt device login",
      `${this.authBaseUrl}/deviceauth/usercode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId, scope: OAUTH_SCOPES }),
      },
      new AbortController().signal,
      this.retry,
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
    if (deviceCode === "") {
      throw new Error("openai-chatgpt device login: response carried no device_code");
    }
    const interval = Number(data.interval ?? 5);
    const expiresInSec = Number(data.expires_in ?? 900);
    return {
      userCode: String(data.user_code ?? ""),
      verificationUri: String(data.verification_uri_complete ?? data.verification_uri ?? "https://chatgpt.com/codex/device"),
      expiresInSec,
      complete: () => this.pollDeviceToken(deviceCode, interval, expiresInSec),
    };
  }

  private async pollDeviceToken(deviceCode: string, intervalSec: number, expiresInSec: number): Promise<ChatGPTTokens> {
    const deadline = this.now() + expiresInSec * 1000;
    let intervalMs = Math.max(1, intervalSec) * 1000;
    while (this.now() < deadline) {
      const res = await this.fetchFn(`${this.authBaseUrl}/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT_TYPE }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && typeof data.access_token === "string") {
        return this.persist(data);
      }
      const err = String(data.error ?? "");
      if (err === "authorization_pending") {
        // keep waiting
      } else if (err === "slow_down") {
        intervalMs += 5000;
      } else if (res.status >= 500) {
        // transient upstream blip; keep polling rather than aborting the login
      } else {
        throw new Error(`openai-chatgpt device login failed: ${err || `HTTP ${res.status}`}`);
      }
      await this.sleep(intervalMs);
    }
    throw new Error("openai-chatgpt device login timed out; run `agentrig login openai-chatgpt` again");
  }

  /**
   * Validate a token response before it is allowed to replace a stored credential. The endpoint
   * is undocumented and expected to drift; a 200 whose shape we don't recognise must fail loudly
   * rather than write `undefined` over a working bundle (which would be unrecoverable).
   */
  private async persist(raw: Record<string, unknown>, previous?: ChatGPTTokens): Promise<ChatGPTTokens> {
    const accessToken = raw.access_token;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new Error(
        "openai-chatgpt: token response carried no access_token (the endpoint may have changed); " +
          "stored credentials were left untouched — re-run `agentrig login openai-chatgpt` if this persists",
      );
    }
    // refresh responses may omit an unchanged field; fall back to the previous value
    const refreshToken = typeof raw.refresh_token === "string" && raw.refresh_token !== ""
      ? raw.refresh_token
      : (previous?.refreshToken ?? "");
    if (refreshToken === "") {
      throw new Error(
        "openai-chatgpt: token response carried no refresh_token and none was stored; " +
          "re-run `agentrig login openai-chatgpt`",
      );
    }
    const idToken = typeof raw.id_token === "string" ? raw.id_token : previous?.idToken;
    const tokens: ChatGPTTokens = {
      accessToken,
      refreshToken,
      lastRefresh: this.now(),
      ...(idToken !== undefined ? { idToken } : {}),
    };
    const accountId = accountIdFromIdToken(idToken) ?? accountIdFromIdToken(accessToken) ?? previous?.accountId;
    if (accountId !== undefined) tokens.accountId = accountId;
    await this.store.write(tokens);
    return tokens;
  }

  /**
   * A valid access token plus the account id, refreshing if it is near expiry (or `force`).
   * Concurrent callers share one in-flight refresh so multiple stream() calls don't race.
   */
  async getAccessToken(force = false): Promise<{ accessToken: string; accountId: string | undefined }> {
    const tokens = await this.store.read();
    if (tokens === null) {
      throw new Error("not signed in to ChatGPT; run `agentrig login openai-chatgpt` first");
    }
    // the account id may only be present in a JWT (esp. for an env-seeded bundle)
    const accountOf = (t: ChatGPTTokens) =>
      t.accountId ?? accountIdFromIdToken(t.idToken) ?? accountIdFromIdToken(t.accessToken);
    const exp = accessTokenExpiry(tokens.accessToken);
    const stale = force || (exp === null
      // an opaque token carries no expiry: fall back to age since the last refresh
      ? this.now() - (tokens.lastRefresh ?? 0) > OPAQUE_TOKEN_MAX_AGE_MS
      : exp - this.now() < REFRESH_SKEW_MS);
    if (!stale) return { accessToken: tokens.accessToken, accountId: accountOf(tokens) };
    if (this.inFlight === null) this.inFlight = this.refresh(tokens).finally(() => (this.inFlight = null));
    const refreshed = await this.inFlight;
    return { accessToken: refreshed.accessToken, accountId: accountOf(refreshed) };
  }

  private async refresh(previous: ChatGPTTokens): Promise<ChatGPTTokens> {
    // RFC 6749 §4.1.3 mandates form encoding at the token endpoint
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: previous.refreshToken,
    });
    let res: Response;
    try {
      res = await fetchWithRetries(
        this.fetchFn,
        "openai-chatgpt token refresh",
        `${this.authBaseUrl}/oauth/token`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
        new AbortController().signal,
        this.retry,
      );
    } catch (err) {
      // retries are exhausted: a 4xx means the grant is bad, anything else is transient and the
      // stored credentials are still good — don't tell the user to re-authenticate for a blip
      const message = err instanceof Error ? err.message : String(err);
      const status = /HTTP (\d{3})/.exec(message)?.[1];
      if (status !== undefined && Number(status) >= 400 && Number(status) < 500) {
        throw new Error(`openai-chatgpt token refresh rejected (HTTP ${status}); re-run \`agentrig login openai-chatgpt\``);
      }
      throw new TransientAuthError(`openai-chatgpt token refresh temporarily failed: ${message}`);
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `openai-chatgpt: token refresh returned an unreadable body (${errorDetail(String(err), 200)}); ` +
          "stored credentials were left untouched",
      );
    }
    return this.persist(raw, previous);
  }
}

/**
 * Strip inherited ACEs and grant the current account full control — the Windows equivalent of
 * the `0600` this file already asks for everywhere else.
 */
async function restrictToOwnerWindows(path: string): Promise<void> {
  const user = process.env.USERNAME;
  if (user === undefined || user === "") throw new Error("USERNAME is not set");
  await new Promise<void>((resolve, reject) => {
    execFile(
      "icacls",
      [path, "/inheritance:r", "/grant:r", `${user}:F`],
      { timeout: 10_000, windowsHide: true },
      (err: Error | null) => (err === null ? resolve() : reject(err)),
    );
  });
}
