import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

/** No credentials in configuration URLs. Literal loopback is the only cleartext exception. */
export const McpHttpUrl = z.string().min(1).max(4096).refine(value => {
  try {
    const u = new URL(value);
    return !/[\u0000-\u0020\u007f]/.test(value) && !u.username && !u.password && !u.hash && !u.search &&
      (u.protocol === "https:" || (u.protocol === "http:" && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(value)));
  } catch { return false; }
}, "MCP requires HTTPS or literal-loopback HTTP without credentials, query or fragment");

export const RemoteMcpConfigSchema = z.object({
  name: z.string().min(1).max(128), url: McpHttpUrl,
  oauth: z.object({
    issuers: z.array(McpHttpUrl).min(1).max(4),
    clientId: z.string().min(1).max(1024).optional(),
    clientMetadataUrl: McpHttpUrl.refine(v => new URL(v).protocol === "https:").optional(),
    endpointOrigins: z.array(McpHttpUrl.refine(v => new URL(v).pathname === "/", "expected an origin, not an endpoint path")).max(4).optional(),
  }).strict().optional(),
}).strict();
export type RemoteMcpConfig = z.infer<typeof RemoteMcpConfigSchema>;

/** Each logical operation owns its entire HTTP/SSE lifetime; no unbounded detached streams. */
export class McpHttpBoundary {
  private readonly scope = new AsyncLocalStorage<{ signal: AbortSignal; count: number }>();
  private readonly lifetime = new AbortController();
  private active = 0;
  private readonly bodies = new Set<Promise<void>>();
  readonly endpoint: URL;
  constructor(readonly config: RemoteMcpConfig, private readonly fetcher: typeof fetch = fetch) {
    RemoteMcpConfigSchema.parse(config);
    this.endpoint = new URL(config.url);
  }

  async operation<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeout = 30_000): Promise<T> {
    const parent = this.scope.getStore();
    if (parent) return fn(AbortSignal.any([parent.signal, ...(signal ? [signal] : [])]));
    if (this.active >= 4) throw new Error("MCP concurrent operation limit (4)");
    this.active++;
    const owned = new AbortController();
    const timer = setTimeout(() => owned.abort(new Error("MCP operation deadline")), timeout);
    const combined = AbortSignal.any([owned.signal, this.lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      return await this.scope.run({ signal: combined, count: 0 }, () => fn(combined));
    } finally { clearTimeout(timer); owned.abort(); this.active--; }
  }

  /** Used by SDK transport AND its OAuth helper, never a global fetch override. */
  readonly fetch: typeof fetch = async (input, init) => {
    const scope = this.scope.getStore();
    if (!scope) throw new Error("MCP network outside an owned operation refused");
    scope.signal.throwIfAborted();
    if (++scope.count > 16) throw new Error("MCP HTTP request limit (16)");
    const u = new URL(input instanceof Request ? input.url : String(input));
    // Discovery query strings are not used; token/authorization params belong in bodies/browser URL.
    McpHttpUrl.parse(u.href);
    const allowed = new Set([this.endpoint.origin,
      ...(this.config.oauth?.issuers ?? []).map(v => new URL(v).origin),
      ...(this.config.oauth?.endpointOrigins ?? []).map(v => new URL(v).origin)]);
    if (!allowed.has(u.origin)) throw new Error("MCP unapproved network origin refused");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    // MCP background listen/subscription streams are deliberately not enabled.
    if (u.href === this.endpoint.href && method === "GET") return new Response(null, { status: 405 });
    if (!["GET", "POST", "DELETE"].includes(method)) throw new Error("MCP HTTP method refused");
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof URLSearchParams))
      throw new Error("MCP request body must be bounded text");
    if (body != null && Buffer.byteLength(String(body)) > 262_144) throw new Error("MCP request exceeds 256 KiB");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("cookie"); headers.delete("proxy-authorization");
    // Resource bearer tokens never travel to metadata/auth endpoints. OAuth client auth belongs
    // solely to the validated SDK token/registration request, not a generic forwarded header.
    if (u.href !== this.endpoint.href && headers.get("authorization")?.startsWith("Bearer "))
      throw new Error("MCP resource token forwarding refused");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("MCP HTTP body deadline")), 10_000);
    const combined = AbortSignal.any([scope.signal, deadline.signal, ...(init?.signal ? [init.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let settle!: () => void;
    const done = new Promise<void>(r => { settle = r; });
    this.bodies.add(done);
    let finished = false;
    const finish = async (): Promise<void> => {
      if (finished) return; finished = true;
      clearTimeout(timer); combined.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
      this.bodies.delete(done); settle();
    };
    const abort = (): void => { void finish(); };
    combined.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(u, { ...init, method, headers, ...(body === undefined ? {} : { body }), redirect: "manual", credentials: "omit", signal: combined });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("MCP redirects refused"); }
      if (Number(response.headers.get("content-length")) > 1_048_576) { await response.body?.cancel(); throw new Error("MCP body exceeds 1 MiB"); }
      reader = response.body?.getReader();
      if (combined.aborted) { await reader?.cancel().catch(() => {}); combined.throwIfAborted(); }
      if (!reader) { await finish(); return response; }
      let bytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            combined.throwIfAborted();
            const chunk = await reader!.read();
            combined.throwIfAborted();
            if (chunk.done) { controller.close(); await finish(); return; }
            bytes += chunk.value.byteLength;
            if (bytes > 1_048_576) throw new Error("MCP decoded body exceeds 1 MiB");
            controller.enqueue(chunk.value);
          } catch (error) { controller.error(error); await finish(); }
        },
        cancel: finish,
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { await finish(); throw error; }
  };

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.all([...this.bodies]);
  }
}
