import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Token lifecycle for the experimental `openai-chatgpt` provider (PLAN §2.9): the "Sign in with
 * ChatGPT" device-code OAuth flow that OpenAI's Codex CLI uses, so an AgentRig run can bill
 * against a ChatGPT Plus/Pro subscription instead of a metered API key.
 *
 * These constants and the request shapes are read from the Apache-2.0 openai/codex source. They
 * talk to undocumented OpenAI endpoints and are expected to drift; this whole provider is
 * experimental and opt-in, never core auth. The `originator` header (in the provider) impersonates
 * the Codex client to pass a server-side whitelist — an accepted cost of the M2.5 decision.
 */

/** Public OAuth client id Codex ships (not a secret). */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const OAUTH_SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** Refresh once the access token is within this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;

export const ChatGPTTokens = z.object({
  accessToken: z.string(),
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

/** Atomic (temp+rename) JSON token store; a corrupt file throws rather than silently re-authing. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string = defaultAuthPath()) {}

  async read(): Promise<ChatGPTTokens | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return ChatGPTTokens.parse(JSON.parse(text));
  }

  async write(tokens: ChatGPTTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(ChatGPTTokens.parse(tokens)), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path);
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
  private inFlight: Promise<ChatGPTTokens> | null = null;

  constructor(opts: OpenAIChatGPTAuthOptions = {}) {
    this.store = opts.store ?? new FileTokenStore();
    this.clientId = opts.clientId ?? CHATGPT_CLIENT_ID;
    this.authBaseUrl = (opts.authBaseUrl ?? AUTH_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Start the device-code flow: returns the code/URL to show the user plus a completion poller. */
  async startDeviceLogin(): Promise<DeviceLogin> {
    const res = await this.fetchFn(`${this.authBaseUrl}/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, scope: OAUTH_SCOPES }),
    });
    if (!res.ok) {
      throw new Error(`openai-chatgpt device login: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const deviceCode = String(data.device_code ?? "");
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
        body: JSON.stringify({ client_id: this.clientId, device_code: deviceCode }),
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
      } else {
        throw new Error(`openai-chatgpt device login failed: ${err || `HTTP ${res.status}`}`);
      }
      await this.sleep(intervalMs);
    }
    throw new Error("openai-chatgpt device login timed out; run `agentrig login openai-chatgpt` again");
  }

  private async persist(raw: Record<string, unknown>, previous?: ChatGPTTokens): Promise<ChatGPTTokens> {
    // refresh responses may omit an unchanged field; fall back to the previous value
    const idToken = typeof raw.id_token === "string" ? raw.id_token : previous?.idToken;
    const tokens: ChatGPTTokens = {
      accessToken: String(raw.access_token),
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : (previous?.refreshToken ?? ""),
      lastRefresh: this.now(),
      ...(idToken !== undefined ? { idToken } : {}),
    };
    const accountId = accountIdFromIdToken(idToken) ?? previous?.accountId;
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
    const exp = accessTokenExpiry(tokens.accessToken);
    const stale = force || (exp !== null && exp - this.now() < REFRESH_SKEW_MS);
    if (!stale) return { accessToken: tokens.accessToken, accountId: tokens.accountId };
    if (this.inFlight === null) this.inFlight = this.refresh(tokens).finally(() => (this.inFlight = null));
    const refreshed = await this.inFlight;
    return { accessToken: refreshed.accessToken, accountId: refreshed.accountId };
  }

  private async refresh(previous: ChatGPTTokens): Promise<ChatGPTTokens> {
    const res = await this.fetchFn(`${this.authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: previous.refreshToken,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `openai-chatgpt token refresh failed: HTTP ${res.status}; re-run \`agentrig login openai-chatgpt\``,
      );
    }
    return this.persist((await res.json()) as Record<string, unknown>, previous);
  }
}
