import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { PermissionRequest } from "./events.js";
import { PermissionClass } from "./permission-types.js";
import { CommandPrefixSchema, ShellOperationSchema } from "./shell-operation.js";

const Name = z.string().min(1).max(256).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const Path = z.string().min(1).max(4096).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const AbsolutePath = Path.refine(isAbsolute, "grant scope must be an absolute path");
export const PermissionGrantSchema = z.object({
  id: Name, subject: Name,
  operation: z.object({ tool: Name, class: PermissionClass.optional(), commandPrefix: CommandPrefixSchema.optional() }).strict(),
  resource: z.union([z.literal("*"), z.object({ kind: z.literal("path-prefix"), path: AbsolutePath }).strict()]),
  constraints: z.object({ cwd: AbsolutePath.optional() }).strict(),
  duration: z.object({ kind: z.enum(["session", "task"]), id: Name }).strict(),
  /** Recorded for R12d; currently the explicitly shared live group is the authority boundary. */
  delegable: z.boolean(), decision: z.enum(["allow", "deny"]), createdAt: z.number().finite().nonnegative(),
}).strict();
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type PermissionGrantSpec = Omit<PermissionGrant, "id" | "createdAt">;
export const PermissionGrantEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("permission.granted"), grant: PermissionGrantSchema }),
  z.object({ type: z.literal("permission.revoked"), grantId: Name, subject: Name, reason: Name }),
]);
export type PermissionGrantEvent = z.infer<typeof PermissionGrantEventSchema>;

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
};
const separateConsent = (req: PermissionRequest): boolean => req.origin === "sandbox-escalation" || req.origin === "mcp-definition-change" || req.origin === "external-input-expansion";

/** Live explicit host/user authority, never reconstructed from events. Paths are lexical scopes,
 * not symlink or OS containment. One registry is one shared authorization group until R12d. */
export class PermissionGrantRegistry {
  readonly subject = randomUUID();
  private readonly grants = new Map<string, PermissionGrant>();
  private readonly pending: PermissionGrantEvent[] = [];
  private draining: Promise<void> | undefined;
  private sessionId: string | undefined;
  private taskId: string | undefined;
  private activeRun: string | undefined;
  private auditBlocked = false;
  private version = 0;
  get revision(): number { return this.version; }
  private readonly limits: { maxGrants?: number; maxPending?: number };
  constructor(limits: { maxGrants?: number; maxPending?: number } = {}) {
    this.limits = { ...limits };
    for (const value of [limits.maxGrants ?? 256, limits.maxPending ?? 1024]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 4096) throw new Error("grant registry limits must be integers from 1 to 4096");
    }
  }
  get context(): { subject: string; sessionId?: string; taskId?: string } {
    return { subject: this.subject, ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }), ...(this.taskId === undefined ? {} : { taskId: this.taskId }) };
  }
  list(): PermissionGrant[] { return structuredClone([...this.grants.values()]); }
  private reserve(count: number): void {
    if (this.pending.length + count > (this.limits.maxPending ?? 1024)) {
      this.auditBlocked = true;
      throw new Error("permission audit queue is full; grants blocked until flush and explicit reset");
    }
  }
  beginSession(sessionId: string): void {
    Name.parse(sessionId);
    if (this.sessionId === sessionId) return;
    if (this.activeRun !== undefined) throw new Error("cannot switch a grant registry while its root run is active");
    this.clear("session-changed"); this.sessionId = sessionId; this.taskId = undefined;
  }
  beginRun(sessionId: string): string {
    if (this.activeRun !== undefined) throw new Error("concurrent root runs require separate grant registries");
    this.beginSession(sessionId);
    this.taskId = randomUUID(); this.activeRun = this.taskId;
    return this.taskId;
  }
  endRun(taskId: string): void {
    if (this.activeRun !== taskId) return;
    const expired = [...this.grants.values()].filter(g => g.duration.kind === "task" && g.duration.id === taskId);
    try {
      this.reserve(expired.length);
      for (const grant of expired) this.revoke(grant.id, "task-ended");
    } finally { this.taskId = undefined; this.activeRun = undefined; }
  }
  grant(spec: PermissionGrantSpec): PermissionGrant {
    const grant = PermissionGrantSchema.parse({ ...spec, id: randomUUID(), createdAt: Date.now() });
    if (grant.subject !== this.subject || grant.duration.id !== (grant.duration.kind === "session" ? this.sessionId : this.taskId)) throw new Error("grant does not belong to the current live subject/duration");
    if (this.grants.size >= (this.limits.maxGrants ?? 256)) throw new Error("permission grant registry is full");
    this.reserve(1);
    this.grants.set(grant.id, grant); this.pending.push({ type: "permission.granted", grant: structuredClone(grant) });
    return structuredClone(grant);
  }
  remember(req: PermissionRequest, decision: "allow" | "deny"): PermissionGrant {
    if (separateConsent(req)) throw new Error("separate consent cannot become a standing grant");
    if (this.sessionId === undefined) throw new Error("no live session for standing permission");
    return this.grant({ subject: this.subject, operation: { tool: req.tool }, resource: "*", constraints: {},
      duration: { kind: "session", id: this.sessionId }, delegable: true, decision });
  }
  revoke(id: string, reason = "explicit-reset"): boolean {
    Name.parse(reason);
    const grant = this.grants.get(id); if (grant === undefined) return false;
    this.reserve(1);
    this.grants.delete(id); this.version++; this.pending.push({ type: "permission.revoked", grantId: id, subject: grant.subject, reason });
    return true;
  }
  clear(reason = "explicit-reset"): number {
    Name.parse(reason); this.reserve(this.grants.size);
    const count = this.grants.size; this.version++;
    for (const id of this.grants.keys()) this.revoke(id, reason);
    this.auditBlocked = false;
    return count;
  }
  /** The head stays queued until append succeeds. Serialized across shared parent/child calls. */
  async flush(emit: (event: PermissionGrantEvent) => Promise<unknown>): Promise<void> {
    const work = async (): Promise<void> => {
      const count = this.pending.length;
      for (let i = 0; i < count; i++) {
        const event = this.pending[0]; if (event === undefined) break;
        await emit(structuredClone(event)); this.pending.shift();
      }
      if (this.pending.length > 0) throw new Error("permission audit changed while flushing; retry before dispatch");
    };
    const promise = (this.draining ?? Promise.resolve()).then(work); this.draining = promise;
    try { await promise; } finally { if (this.draining === promise) this.draining = undefined; }
  }
  decide(req: PermissionRequest, auditRequired = false): "allow" | "deny" | "ask" {
    if (separateConsent(req)) return "ask";
    if (this.auditBlocked || (auditRequired && this.pending.length > 0)) return "deny";
    for (const grant of this.grants.values()) {
      if (grant.subject !== this.subject || grant.duration.id !== (grant.duration.kind === "session" ? this.sessionId : this.taskId)) continue;
      if (grant.operation.tool !== req.tool || (grant.operation.class !== undefined && grant.operation.class !== req.class)) continue;
      if (grant.operation.commandPrefix !== undefined) {
        const parsed = ShellOperationSchema.safeParse(req.operation);
        if (!parsed.success || parsed.data.status !== "parsed" || parsed.data.background) continue;
        const argv = parsed.data.argv;
        if (!grant.operation.commandPrefix.every((word, index) => argv[index] === word)) continue;
      }
      if (grant.constraints.cwd !== undefined && resolve(req.cwd) !== resolve(grant.constraints.cwd)) continue;
      if (grant.resource !== "*") {
        if (req.paths === undefined || req.paths.length === 0 || req.paths.length > 128) continue;
        const root = resolve(req.cwd, grant.resource.path);
        if (!req.paths.every(path => Path.safeParse(path).success && inside(root, resolve(req.cwd, path)))) continue;
      }
      return grant.decision;
    }
    return "ask";
  }
}
