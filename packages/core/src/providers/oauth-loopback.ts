import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

/**
 * The browser half of an OAuth login: PKCE, an authorize URL, and a one-shot listener on
 * loopback for the redirect.
 *
 * This shape exists because the device-code flow cannot work. `auth.openai.com` puts an
 * interactive Cloudflare challenge in front of both `/deviceauth/usercode` and `/oauth/authorize`
 * (verified: `cf-mitigated: challenge`, 403, from a cloud container AND a desktop), and the
 * challenge targets the HTTP *client* — `fetch` is not a browser wherever it runs. Here the
 * browser makes the challenged request and we never do: this process only serves the redirect on
 * 127.0.0.1 and posts the code to the token endpoint, which is not challenged.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. The verifier is what proves, later, that the same client started the flow. */
export function createPkce(random: (bytes: number) => Buffer = randomBytes): PkcePair {
  const verifier = random(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Opaque, single-use, and checked on the way back: a redirect that fails it is not ours. */
export function createState(random: (bytes: number) => Buffer = randomBytes): string {
  return random(16).toString("base64url");
}

export interface AuthorizeUrlOptions {
  authBaseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  challenge: string;
  state: string;
  /** Extra query parameters the provider expects; `id_token_add_organizations` for ChatGPT. */
  extra?: Record<string, string>;
}

export function authorizeUrl(o: AuthorizeUrlOptions): string {
  const url = new URL(`${o.authBaseUrl.replace(/\/$/, "")}/oauth/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: o.scope,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    state: o.state,
    ...o.extra,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export interface LoopbackCallback {
  code: string;
}

export interface LoopbackListener {
  /** The redirect URI the authorize request must name, exactly. */
  redirectUri: string;
  /**
   * The addresses actually bound. Every one must be loopback: an authorization code arriving
   * over the network would be a code anyone on it could have sent.
   */
  addresses: string[];
  /** Resolves on the first valid callback; rejects on an error redirect, a bad state, or timeout. */
  wait: Promise<LoopbackCallback>;
  /** Idempotent. Destroys open sockets too, or a keep-alive browser connection holds the process. */
  close(): void;
}

export interface ListenOptions {
  port: number;
  /** Always loopback in practice: binding wider would expose the authorization code. */
  host?: string;
  path?: string;
  expectedState: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to `node:http`. */
  createHttpServer?: typeof createServer;
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui;margin:4rem auto;max-width:32rem;line-height:1.5">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

/**
 * Serves exactly one authorization redirect on loopback.
 *
 * A browser sends more than the redirect — `/favicon.ico` at least — so anything but the callback
 * path is a 404 rather than a reason to fail the login. The authorization code is never echoed
 * into the page: it is a credential, and the page is the one place a shoulder-surfer looks.
 */
export async function listenForCallback(opts: ListenOptions): Promise<LoopbackListener> {
  const path = opts.path ?? "/auth/callback";
  const make = opts.createHttpServer ?? createServer;

  interface Settle {
    resolve: (c: LoopbackCallback) => void;
    reject: (e: Error) => void;
  }
  let settle: Settle | null = null;
  const wait = new Promise<LoopbackCallback>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // a rejection nobody has attached to yet must not crash the process
  wait.catch(() => {});
  /**
   * Settles once and then shuts down. The callback is handed the settler rather than reading it
   * from the closure: clearing `settle` first is what makes this single-shot, and a callback that
   * read it afterwards would find null and settle nothing at all.
   */
  const done = (fn: (s: Settle) => void): void => {
    const current = settle;
    if (current === null) return;
    settle = null;
    fn(current);
    close();
  };

  const servers: Server[] = [];
  const addresses: string[] = [];
  const sockets = new Set<Socket>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    // destroy first: `server.close()` waits for open connections, and a browser's keep-alive
    // socket would hold the process open long after the login finished
    for (const s of sockets) s.destroy();
    sockets.clear();
    for (const s of servers) s.close();
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      // a browser asks for /favicon.ico too; that is not a reason to fail a login
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (error !== null) {
      const detail = url.searchParams.get("error_description") ?? error;
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE("Sign-in failed", "You can close this window."));
      done((s) => s.reject(new Error(`authorization failed: ${detail}`)));
      return;
    }
    if (state !== opts.expectedState) {
      // someone else's redirect, or a forged one: never exchange a code we did not ask for
      res.writeHead(400, { "content-type": "text/html" }).end(PAGE("Unexpected request", "You can close this window."));
      done((s) => s.reject(new Error("authorization state did not match; the redirect was not ours")));
      return;
    }
    if (code === null || code === "") {
      res.writeHead(400, { "content-type": "text/html" }).end(PAGE("Unexpected request", "You can close this window."));
      done((s) => s.reject(new Error("authorization redirect carried no code")));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(
      PAGE("Signed in", "You can close this window and return to the terminal."),
    );
    done((s) => s.resolve({ code }));
  };

  const bind = async (host: string, port: number): Promise<Server> => {
    const server = make(onRequest);
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(
                `port ${port} is already in use — the sign-in redirect must arrive there. ` +
                  "Close whatever is listening (another login, or `codex login`) and try again.",
              )
            : err,
        );
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    servers.push(server);
    const bound = server.address();
    if (typeof bound === "object" && bound !== null) addresses.push(bound.address);
    return server;
  };

  // Both loopback stacks, because the browser decides which one `localhost` means and it is not
  // always the same one Node would pick — on Windows it is usually ::1, and a 127.0.0.1-only
  // listener simply never hears the redirect.
  const v4 = await bind(opts.host ?? "127.0.0.1", opts.port);
  const address = v4.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  if (opts.host === undefined) {
    // best-effort: a host with no IPv6 loopback is fine, it will use the v4 listener
    await bind("::1", port).catch(() => undefined);
  }
  const redirectUri = `http://localhost:${port}${path}`;

  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      done((s) => s.reject(new Error("timed out waiting for the browser to complete sign-in")));
    }, opts.timeoutMs);
    timer.unref?.();
  }

  return { redirectUri, addresses, wait, close };
}
