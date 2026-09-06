import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { auth, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens, type OAuthClientInformationContext } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createState, listenForCallback } from "../providers/oauth-loopback.js";
import { restrictToOwnerWindows } from "../providers/openai-chatgpt-auth.js";
import { McpHttpBoundary, McpHttpUrl, type RemoteMcpConfig } from "./http.js";

const ClientInfo = z.object({ client_id: z.string().min(1).max(4096), issuer: z.string().min(1).max(4096) }).passthrough();
const Tokens = z.object({ access_token: z.string().min(1).max(16_384), token_type: z.string().min(1),
  refresh_token: z.string().max(16_384).optional(), expires_in: z.number().nonnegative().optional(),
  scope: z.string().max(16_384).optional(),
  issuer: z.string().min(1).max(4096) }).passthrough();
const RecordSchema = z.object({ version: z.literal(1), endpoint: z.string(), issuer: z.string(),
  redirectUri: z.string().url().max(4096),
  client: ClientInfo, tokens: Tokens, savedAt: z.number().nonnegative(), discovery: z.record(z.unknown()) }).strict();
type Credential = z.infer<typeof RecordSchema>;

/** Separate owner-restricted plaintext store. Locks are cooperative, never stolen. */
export class McpCredentialStore {
  readonly path: string;
  constructor(readonly root: string, readonly endpoint: string,
    private readonly restrict: (path: string) => Promise<void> = process.platform === "win32" ? restrictToOwnerWindows : async () => {}) {
    this.path = join(root, `${createHash("sha256").update(endpoint).digest("hex")}.json`);
  }
  private async checkDirectories(): Promise<void> {
    // The host chooses the user-state parent; refuse replacing either state directory with
    // a link. This is cooperative filesystem protection, not hostile-writer containment.
    for (const path of [dirname(this.root), this.root]) {
      try { const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("MCP credential directory refused"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  }
  private async directory(): Promise<void> {
    await this.checkDirectories();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MCP credential directory refused");
  }
  async read(): Promise<Credential | undefined> {
    try {
      await this.checkDirectories();
      const st = await lstat(this.path);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 65_536) throw new Error("MCP credential file refused");
      const handle = await open(this.path, "r");
      try {
        const actual = await handle.stat();
        if (actual.ino !== st.ino || actual.dev !== st.dev) throw new Error("MCP credential file changed");
        const bytes = Buffer.alloc(65_537); let offset = 0;
        while (offset < bytes.length) { const n = await handle.read(bytes, offset, bytes.length - offset, null); if (!n.bytesRead) break; offset += n.bytesRead; }
        if (offset > 65_536) throw new Error("MCP credential file exceeds bound");
        const value = RecordSchema.parse(JSON.parse(bytes.subarray(0, offset).toString()));
        if (value.endpoint !== this.endpoint || value.issuer !== value.tokens.issuer || value.issuer !== value.client.issuer)
          throw new Error("MCP credential binding mismatch");
        return value;
      } finally { await handle.close(); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("MCP credentials unavailable or invalid; inspect owner state and log in explicitly"); }
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.directory(); const lock = `${this.path}.lock`;
    await mkdir(lock, { mode: 0o700 });
    try { return await fn(); } finally { await rmdir(lock); }
  }
  async write(value: Credential): Promise<void> {
    const text = JSON.stringify(RecordSchema.parse(value));
    if (Buffer.byteLength(text) > 65_536) throw new Error("MCP credentials exceed bound");
    await this.directory();
    try { const st = await lstat(this.path); if (!st.isFile() || st.isSymbolicLink()) throw new Error("MCP credential destination refused"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const h = await open(temp, "wx", 0o600); try { await h.writeFile(text); await h.chmod(0o600); } finally { await h.close(); }
      await this.restrict(temp); // refuse publication if owner ACL could not be established
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  }
}

/** Host-owned flow; model text cannot install metadata, redirect targets or token records. */
export class McpOAuthProvider implements OAuthClientProvider {
  get clientMetadata() { return { client_name: "AgentRig", grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none" as const,
    redirect_uris: this.redirectUrl ? [this.redirectUrl] : [] }; }
  readonly clientMetadataUrl?: string;
  private record: Credential | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private client: StoredOAuthClientInformation | undefined;
  private verifier = "";
  private readonly stateValue = createState();
  redirectUrl: string | undefined;
  onRedirect: ((url: URL) => void | Promise<void>) | undefined;
  constructor(readonly config: RemoteMcpConfig, readonly store: McpCredentialStore, readonly interactive = false) {
    if (!config.oauth) throw new Error("MCP OAuth configuration required");
    if (config.oauth.clientMetadataUrl) this.clientMetadataUrl = config.oauth.clientMetadataUrl;
  }
  async load(): Promise<void> {
    this.record = await this.store.read();
    if (this.record && (!this.config.oauth!.issuers.includes(this.record.issuer) ||
      (this.config.oauth!.clientId !== undefined && this.record.client.client_id !== this.config.oauth!.clientId)))
      throw new Error("MCP credential issuer/client changed; explicit login required");
    this.client = this.record?.client as StoredOAuthClientInformation | undefined;
    if (this.record) {
      const redirect = new URL(this.record.redirectUri);
      if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash)
        throw new Error("MCP stored redirect binding refused");
      // A refresh still belongs to the original public authorization-code client. Omitting
      // redirectUrl would ask the SDK to select its non-interactive client-credentials flow.
      this.redirectUrl = this.record.redirectUri;
      this.saveDiscoveryState(this.record.discovery as unknown as OAuthDiscoveryState);
    }
  }
  state(): string { return this.stateValue; }
  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    if (ctx && !this.config.oauth!.issuers.includes(ctx.issuer)) throw new Error("MCP issuer not approved");
    if (this.client && (!ctx || this.client.issuer === ctx.issuer)) return this.client;
    if (!this.interactive) throw new Error("MCP explicit login required; automatic registration disabled");
    return this.config.oauth!.clientId && ctx ? { client_id: this.config.oauth!.clientId, issuer: ctx.issuer } : undefined;
  }
  async saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!this.interactive || !ctx || !this.config.oauth!.issuers.includes(ctx.issuer) || value.issuer !== ctx.issuer)
      throw new Error("MCP client registration refused");
    this.client = ClientInfo.parse(value) as StoredOAuthClientInformation;
  }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.record && (!ctx || this.record.issuer === ctx.issuer) ? this.record.tokens as StoredOAuthTokens : undefined;
  }
  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    if (!ctx || !this.config.oauth!.issuers.includes(ctx.issuer) || tokens.issuer !== ctx.issuer || !this.discovery)
      throw new Error("MCP token issuer binding refused");
    const client = await this.clientInformation(ctx);
    if (!client) throw new Error("MCP missing client binding");
    if (!this.interactive) {
      const previous = new Set((this.record?.tokens.scope ?? "").split(/\s+/).filter(Boolean));
      if (tokens.scope?.split(/\s+/).filter(Boolean).some(scope => !previous.has(scope)))
        throw new Error("MCP scope expansion requires explicit login");
      if (tokens.scope === undefined && this.record?.tokens.scope !== undefined) tokens = { ...tokens, scope: this.record.tokens.scope };
    }
    const next = RecordSchema.parse({ version: 1, endpoint: this.store.endpoint, issuer: ctx.issuer,
      client, tokens, redirectUri: this.redirectUrl, savedAt: Date.now(), discovery: this.discovery });
    await this.store.write(next); this.record = next;
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive || !this.onRedirect || !this.discovery?.authorizationServerMetadata)
      throw new Error("MCP explicit login required; browser and scope changes disabled");
    const expected = this.discovery.authorizationServerMetadata.authorization_endpoint;
    const base = new URL(url); base.search = "";
    if (base.href !== expected || url.searchParams.get("state") !== this.stateValue || url.searchParams.get("redirect_uri") !== this.redirectUrl)
      throw new Error("MCP authorization redirect binding refused");
    await this.onRedirect(url);
  }
  saveCodeVerifier(value: string): void { if (!this.interactive || value.length > 256) throw new Error("MCP PKCE refused"); this.verifier = value; }
  codeVerifier(): string { if (!this.verifier) throw new Error("MCP missing PKCE"); return this.verifier; }
  async validateResourceURL(server: string | URL, resource?: string): Promise<URL> {
    const endpoint = new URL(this.config.url);
    if (new URL(server).href !== endpoint.href || (resource !== undefined && new URL(resource).href !== endpoint.href))
      throw new Error("MCP resource audience mismatch");
    return endpoint;
  }
  saveDiscoveryState(value: OAuthDiscoveryState): void {
    const issuer = value.authorizationServerMetadata?.issuer;
    if (!issuer || !this.config.oauth!.issuers.includes(issuer) || value.authorizationServerUrl !== issuer)
      throw new Error("MCP discovery issuer mismatch");
    if (Buffer.byteLength(JSON.stringify(value)) > 32_768) throw new Error("MCP discovery metadata exceeds bound");
    const allowed = new Set([new URL(this.config.url).origin,
      ...this.config.oauth!.issuers.map(v => new URL(v).origin),
      ...(this.config.oauth!.endpointOrigins ?? []).map(v => new URL(v).origin)]);
    for (const endpoint of [value.authorizationServerMetadata?.authorization_endpoint,
      value.authorizationServerMetadata?.token_endpoint, value.authorizationServerMetadata?.registration_endpoint]) {
      if (endpoint !== undefined && (!McpHttpUrl.safeParse(endpoint).success || !allowed.has(new URL(endpoint).origin)))
        throw new Error("MCP authorization endpoint not approved");
    }
    this.discovery = structuredClone(value);
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  invalidateCredentials(): never { throw new Error("MCP credentials rejected; explicit login required (stored credentials preserved)"); }

  /** Refresh is a single owned network operation; competing processes cannot rotate twice. */
  async refresh(http: McpHttpBoundary, signal?: AbortSignal): Promise<void> {
    const previousToken = this.record?.tokens.access_token;
    await this.store.locked(async () => {
      await this.load();
      if (previousToken !== undefined && this.record?.tokens.access_token !== previousToken) return;
      if (!this.record?.tokens.refresh_token) throw new Error("MCP explicit login required");
      await http.operation(async () => {
        const scope = typeof this.record?.tokens.scope === "string" ? this.record.tokens.scope : undefined;
        if (await auth(this, { serverUrl: this.config.url, fetchFn: http.fetch, ...(scope ? { scope } : {}) }) !== "AUTHORIZED")
          throw new Error("MCP explicit login required");
      }, signal);
    });
  }
}

export async function loginMcp(config: RemoteMcpConfig, store: McpCredentialStore,
  opts: { authorize: () => Promise<boolean>; onAuthorizationUrl: (url: string) => void | Promise<void>; signal?: AbortSignal; fetch?: typeof fetch }): Promise<void> {
  if (await opts.authorize() !== true) throw new Error("MCP login network permission refused");
  const provider = new McpOAuthProvider(config, store, true);
  const http = new McpHttpBoundary(config, opts.fetch);
  const listener = await listenForCallback({ port: 0, expectedState: provider.state(), captureParams: true, timeoutMs: 120_000 });
  // A browser can reject/call back while the SDK is still awaiting redirectToAuthorization.
  // Observe that rejection immediately; the later await still receives the same failure.
  void listener.wait.catch(() => {});
  provider.redirectUrl = listener.redirectUri;
  provider.onRedirect = url => opts.onAuthorizationUrl(url.href);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider: provider, fetch: http.fetch, onInsufficientScope: "throw" });
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(opts.signal ? [opts.signal] : [])]);
  const abortWait = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("MCP login cancelled or timed out")), { once: true }));
  try {
    await store.locked(async () => {
      // Explicit login starts fresh discovery, not cached issuer metadata from a previous flow.
      const result = await http.operation(() => auth(provider, { serverUrl: config.url, fetchFn: http.fetch }), signal);
      if (result !== "REDIRECT") throw new Error("MCP login did not request browser authorization");
      const callback = await Promise.race([listener.wait, abortWait]);
      if (!callback.params || callback.params.get("state") !== provider.state()) throw new Error("MCP OAuth state mismatch");
      await http.operation(() => transport.finishAuth(callback.params!), signal);
    });
  } catch { throw new Error("MCP login failed or cancelled; stored credentials were not replaced unless token exchange completed"); }
  finally { listener.close(); await transport.close(); await http.close(); }
}
