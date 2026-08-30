import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  InitializeResult,
  JsonRpcResponse,
  PROTOCOL_VERSION,
  ToolsCallResult,
  ToolsListResult,
  type McpToolSpec,
} from "./protocol.js";

/**
 * A stdio MCP client. One child process, newline-delimited JSON-RPC.
 *
 * Everything here is defensive in the same direction: **a misbehaving server must not be able to
 * hang or crash the agent.** An MCP server is third-party code the user pointed at, exactly like
 * a hook, and the M7a lesson applies unchanged — every request is timeout-bounded, a
 * non-conforming reply is rejected rather than trusted, and a dead child is reported rather than
 * leaving requests pending forever.
 */

export interface McpServerConfig {
  /** Identifies the server, and namespaces its tools. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface McpClientOptions {
  /** Injected for tests: returns a process-like object. */
  spawnFn?: typeof spawn;
  onError?: (err: Error) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private startError: Error | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly opts: McpClientOptions = {},
  ) {}

  get name(): string {
    return this.config.name;
  }

  /** Spawns the server and performs the MCP handshake. */
  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? spawn;
    const child = spawnFn(this.config.command, this.config.args ?? [], {
      // the server's env is NOT inherited wholesale: a user pointing at a third-party binary
      // should not hand it every secret in their shell
      env: { PATH: process.env.PATH ?? "", ...(this.config.env ?? {}) },
      ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("error", (err) => this.fail(new Error(`mcp ${this.config.name} failed to start: ${err.message}`)));
    child.on("exit", (code, signal) =>
      this.fail(new Error(`mcp ${this.config.name} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`)),
    );
    // a server that logs to stderr is normal; a server that logs to stdout breaks the protocol,
    // and the parse error below is where that shows up
    child.stderr.on("data", () => {});

    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.onLine(line));

    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agentrig", version: "0.0.0" },
    });
    const parsed = InitializeResult.safeParse(result);
    if (!parsed.success) {
      throw new Error(`mcp ${this.config.name}: initialize returned an unrecognised result`);
    }
    // per spec the client confirms with a notification; a server may wait for it before serving
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolSpec[]> {
    const out: McpToolSpec[] = [];
    let cursor: string | undefined;
    // paginate, but bounded: a server returning a cursor forever would loop here
    for (let page = 0; page < 20; page += 1) {
      const parsed = ToolsListResult.safeParse(
        await this.request("tools/list", cursor === undefined ? {} : { cursor }),
      );
      if (!parsed.success) throw new Error(`mcp ${this.config.name}: tools/list returned an unrecognised result`);
      out.push(...parsed.data.tools);
      if (parsed.data.nextCursor === undefined) return out;
      cursor = parsed.data.nextCursor;
    }
    this.opts.onError?.(new Error(`mcp ${this.config.name}: tools/list paginated past 20 pages; truncating`));
    return out;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<ToolsCallResult> {
    const parsed = ToolsCallResult.safeParse(
      await this.request("tools/call", { name, arguments: args ?? {} }, signal),
    );
    if (!parsed.success) throw new Error(`mcp ${this.config.name}: ${name} returned an unrecognised result`);
    return parsed.data;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.fail(new Error(`mcp ${this.config.name}: client closed`));
    this.reader?.close();
    const child = this.child;
    if (child === null) return;
    child.stdin.end();
    // detached kill of the group, same as the bash tool: a server that ignores SIGTERM and has
    // spawned children of its own would otherwise outlive the harness
    child.kill("SIGTERM");
    await new Promise<void>((r) => setTimeout(r, 50).unref?.());
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`mcp ${this.config.name}: client is closed`));
    if (this.startError !== null) return Promise.reject(this.startError);
    const child = this.child;
    if (child === null) return Promise.reject(new Error(`mcp ${this.config.name}: not started`));

    const id = this.nextId++;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${this.config.name}: ${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });

      const onAbort = (): void => {
        const p = this.pending.get(id);
        if (p === undefined) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(new Error(`mcp ${this.config.name}: ${method} aborted`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();

      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // a server writing non-JSON to stdout has broken the protocol; say so once per line
      // rather than crashing the reader
      this.opts.onError?.(new Error(`mcp ${this.config.name}: ignoring non-JSON on stdout`));
      return;
    }

    const parsed = JsonRpcResponse.safeParse(value);
    // a notification has no id and is not a reply to anything
    if (!parsed.success || parsed.data.id === null || parsed.data.id === undefined) return;
    const id = typeof parsed.data.id === "number" ? parsed.data.id : Number(parsed.data.id);
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    clearTimeout(p.timer);

    if (parsed.data.error !== undefined) {
      p.reject(new Error(`mcp ${this.config.name}: ${parsed.data.error.message}`));
      return;
    }
    p.resolve(parsed.data.result);
  }

  /** Rejects everything outstanding — a dead child must not leave requests pending forever. */
  private fail(err: Error): void {
    if (this.startError === null && !this.closed) this.startError = err;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
