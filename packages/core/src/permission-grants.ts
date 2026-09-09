import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { AgentRoleToolNames } from "./manifests.js";
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
  /** Only delegable records are visible to descendants; own records remain visible. */
  delegable: z.boolean(), decision: z.enum(["allow", "deny"]), createdAt: z.number().finite().nonnegative(),
}).strict();
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type PermissionGrantSpec = Omit<PermissionGrant, "id" | "createdAt">;
export interface GrantAuthorization { decision: "allow" | "deny" | "ask"; grantId?: string; auditBlocked?: boolean; viewExpired?: boolean }
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

/** Pure scope check shared by runtime enforcement and approval previews. This does not grant
 * authority or check live subject/duration; callers must validate/install records separately. */
export function permissionGrantCoversRequest(grant: PermissionGrantSpec, req: PermissionRequest): boolean {
  if (separateConsent(req)) return false;
  if (grant.operation.tool !== req.tool || (grant.operation.class !== undefined && grant.operation.class !== req.class)) return false;
  if (grant.operation.commandPrefix !== undefined) {
    const parsed = ShellOperationSchema.safeParse(req.operation);
    if (!parsed.success || parsed.data.status !== "parsed" || parsed.data.background) return false;
    if (!grant.operation.commandPrefix.every((word, index) => parsed.data.status === "parsed" && parsed.data.argv[index] === word)) return false;
  }
  if (grant.constraints.cwd !== undefined && resolve(req.cwd) !== resolve(grant.constraints.cwd)) return false;
  if (grant.resource !== "*") {
    if (req.paths === undefined || req.paths.length === 0 || req.paths.length > 128) return false;
    const root = resolve(req.cwd, grant.resource.path);
    if (!req.paths.every(path => Path.safeParse(path).success && inside(root, resolve(req.cwd, path)))) return false;
  }
  return true;
}

/** Live explicit host/user authority, never reconstructed from events. Paths are lexical scopes,
 * not symlink or OS containment. Views share bounded audit/counters, never copy authority. */
export class PermissionGrantRegistry {
  readonly subject = randomUUID();
  private state: {
    grants: Map<string, PermissionGrant>; matchedDecisions: Map<string, number>; pending: PermissionGrantEvent[];
    draining: Promise<void> | undefined; sessionId: string | undefined; taskId: string | undefined;
    activeRun: string | undefined; auditBlocked: boolean; version: number; views: number;
    owners: Map<string, { session: string; task: string }>; rootSubject: string;
    limits: { maxGrants?: number; maxPending?: number; maxViews?: number };
  };
  private ancestors: readonly string[] = [];
  private allowedTools: ReadonlySet<string> | undefined;
  private seal: { session: string; task: string } | undefined;
  get revision(): number { return this.state.version; }
  get isChildView(): boolean { return this.seal !== undefined; }
  get active(): boolean { return this.seal === undefined || (this.seal.session === this.state.sessionId && this.seal.task === this.state.activeRun); }
  constructor(limits: { maxGrants?: number; maxPending?: number; maxViews?: number } = {}) {
    for (const value of [limits.maxGrants ?? 256, limits.maxPending ?? 1024, limits.maxViews ?? 256]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 4096) throw new Error("grant registry limits must be integers from 1 to 4096");
    }
    this.state = { grants: new Map(), matchedDecisions: new Map(), pending: [], draining: undefined,
      sessionId: undefined, taskId: undefined, activeRun: undefined, auditBlocked: false, version: 0,
      views: 0, owners: new Map(), rootSubject: this.subject, limits: { ...limits } };
  }
  /** A live view, not a copy of grants. Old child views never reactivate on a later root task. */
  childView(toolAllowlist?: readonly string[]): PermissionGrantRegistry {
    if (toolAllowlist !== undefined) toolAllowlist = AgentRoleToolNames.parse(toolAllowlist);
    this.requireActive();
    if (this.state.sessionId === undefined || this.state.activeRun === undefined) throw new Error("child grants require an active root run");
    if (this.state.views >= (this.state.limits.maxViews ?? 256) || this.ancestors.length >= 64) throw new Error("permission child-view limit reached");
    const child = new PermissionGrantRegistry(this.state.limits);
    child.state = this.state;
    const inherited = this.allowedTools;
    child.allowedTools = toolAllowlist === undefined ? inherited : new Set(toolAllowlist.filter(name => inherited === undefined || inherited.has(name)));
    child.ancestors = Object.freeze([...this.ancestors, this.subject]);
    child.seal = { session: this.state.sessionId, task: this.state.activeRun };
    this.state.owners.set(child.subject, child.seal); this.state.views++;
    return child;
  }
  private requireActive(): void { if (!this.active) throw new Error("permission child view expired"); }
  private requireRoot(): void { if (this.isChildView) throw new Error("child views cannot change root grant lifecycle"); }
  get context(): { subject: string; sessionId?: string; taskId?: string } {
    return { subject: this.subject, ...(this.state.sessionId === undefined ? {} : { sessionId: this.state.sessionId }), ...(this.state.taskId === undefined ? {} : { taskId: this.state.taskId }) };
  }
  list(): PermissionGrant[] { return structuredClone([...this.state.grants.values()].filter(grant => !this.isChildView || this.visible(grant))); }
  /** Live records only. Pure inspection never counts as an authorization decision. */
  inspect(): Array<{ grant: PermissionGrant; matchedDecisions: number; countSaturated: boolean; auditBlocked: boolean }> {
    return this.list().filter(grant => this.live(grant)).map(grant => {
      const matchedDecisions = this.state.matchedDecisions.get(grant.id) ?? 0;
      return { grant, matchedDecisions, countSaturated: matchedDecisions === Number.MAX_SAFE_INTEGER, auditBlocked: this.state.auditBlocked };
    });
  }
  private live(grant: PermissionGrant): boolean {
    const owner = this.state.owners.get(grant.subject);
    return this.active && (grant.subject === this.state.rootSubject || (owner !== undefined && owner.session === this.state.sessionId && owner.task === this.state.activeRun))
      && grant.duration.id === (grant.duration.kind === "session" ? this.state.sessionId : this.state.taskId);
  }
  private visible(grant: PermissionGrant): boolean {
    return this.live(grant) && (grant.subject === this.subject || (grant.delegable && this.ancestors.includes(grant.subject)));
  }
  private reserve(count: number): void {
    const limit = this.state.limits.maxPending ?? 1024;
    if (this.state.pending.length + count > limit) {
      this.state.auditBlocked = true;
      throw new Error(`permission audit queue is full: ${this.state.pending.length} of ${limit} receipts are still unlogged and this change needs ${count} more. `
        + "Grants stay blocked until the queue is flushed to the session log and then explicitly reset; nothing queued is discarded. "
        + "A queue that never empties means the host is not draining it, not that the limit is too small.");
    }
  }
  beginSession(sessionId: string): void {
    this.requireRoot();
    Name.parse(sessionId);
    if (this.state.sessionId === sessionId) return;
    if (this.state.activeRun !== undefined) throw new Error("cannot switch a grant registry while its root run is active");
    this.clear("session-changed"); this.state.sessionId = sessionId; this.state.taskId = undefined;
  }
  beginRun(sessionId: string): string {
    this.requireRoot();
    if (this.state.activeRun !== undefined) throw new Error("concurrent root runs require separate grant registries");
    this.beginSession(sessionId);
    this.state.taskId = randomUUID(); this.state.activeRun = this.state.taskId;
    return this.state.taskId;
  }
  endRun(taskId: string): void {
    this.requireRoot();
    if (this.state.activeRun !== taskId) return;
    const expired = [...this.state.grants.values()].filter(g => g.subject !== this.subject || (g.duration.kind === "task" && g.duration.id === taskId));
    try {
      this.reserve(expired.length);
      for (const grant of expired) this.revoke(grant.id, "task-ended");
    } finally { this.state.taskId = undefined; this.state.activeRun = undefined; this.state.owners.clear(); this.state.views = 0; }
  }
  grant(spec: PermissionGrantSpec): PermissionGrant {
    this.requireActive();
    const grant = PermissionGrantSchema.parse({ ...spec, id: randomUUID(), createdAt: Date.now() });
    if (grant.subject !== this.subject || grant.duration.id !== (grant.duration.kind === "session" ? this.state.sessionId : this.state.taskId)) throw new Error("grant does not belong to the current live subject/duration");
    if (this.state.grants.size >= (this.state.limits.maxGrants ?? 256)) throw new Error("permission grant registry is full");
    this.reserve(1);
    this.state.grants.set(grant.id, grant); this.state.matchedDecisions.set(grant.id, 0); this.state.pending.push({ type: "permission.granted", grant: structuredClone(grant) });
    return structuredClone(grant);
  }
  remember(req: PermissionRequest, decision: "allow" | "deny"): PermissionGrant {
    if (separateConsent(req)) throw new Error("separate consent cannot become a standing grant");
    if (this.state.sessionId === undefined) throw new Error("no live session for standing permission");
    return this.grant({ subject: this.subject, operation: { tool: req.tool }, resource: "*", constraints: {},
      duration: { kind: "session", id: this.state.sessionId }, delegable: true, decision });
  }
  revoke(id: string, reason = "explicit-reset"): boolean {
    this.requireActive();
    Name.parse(reason);
    const grant = this.state.grants.get(id); if (grant === undefined) return false;
    if (this.isChildView && grant.subject !== this.subject) throw new Error("child views can revoke only their own grants");
    this.reserve(1);
    this.state.grants.delete(id); this.state.matchedDecisions.delete(id); this.state.version++; this.state.pending.push({ type: "permission.revoked", grantId: id, subject: grant.subject, reason });
    return true;
  }
  clear(reason = "explicit-reset"): number {
    this.requireActive();
    const records = [...this.state.grants.values()].filter(grant => !this.isChildView || grant.subject === this.subject);
    Name.parse(reason); this.reserve(records.length);
    const count = records.length; this.state.version++;
    for (const grant of records) this.revoke(grant.id, reason);
    if (!this.isChildView) this.state.auditBlocked = false;
    return count;
  }
  /** The head stays queued until append succeeds. Serialized across shared parent/child calls. */
  async flush(emit: (event: PermissionGrantEvent) => Promise<unknown>): Promise<void> {
    const work = async (): Promise<void> => {
      // Bounded by the queue limit rather than by a snapshot taken on entry. Since R10 admits
      // parallel tool calls, ANOTHER call's grant can legitimately land in this shared queue while
      // this flush is awaiting its appends; a snapshot count then reported that as "changed while
      // flushing" and failed a call that had done nothing wrong. Every receipt in the queue is
      // bound for the same log, so this drains it rather than fighting over who queued what.
      // The bound is what stops an endlessly granting caller from holding the drain open, and
      // reaching it is still the fail-closed refusal it has always been: retry before dispatch.
      const limit = this.state.limits.maxPending ?? 1024;
      for (let appended = 0; appended <= limit; appended++) {
        const event = this.state.pending[0]; if (event === undefined) return;
        await emit(structuredClone(event)); this.state.pending.shift();
      }
      throw new Error("permission audit changed while flushing; retry before dispatch");
    };
    const promise = (this.state.draining ?? Promise.resolve()).then(work); this.state.draining = promise;
    try { await promise; } finally { if (this.state.draining === promise) this.state.draining = undefined; }
  }
  decide(req: PermissionRequest, auditRequired = false, denialsOnly = false): "allow" | "deny" | "ask" {
    return this.match(req, auditRequired, denialsOnly).decision;
  }
  /** Count matched allow/deny decisions, not executions. The core calls this once when
   * base policy asks, or to honor fresh-boundary denies; previews keep using pure decide(). */
  authorize(req: PermissionRequest, auditRequired = true, countMode: "all" | "deny-only" = "all", denialsOnly = false): GrantAuthorization {
    const result = this.match(req, auditRequired, denialsOnly);
    // A separate fresh-consent gate may honor an existing deny while overriding any allow.
    // Count only the decision actually consumed; never count its inspected allow as authority.
    if (result.grantId !== undefined && (countMode === "all" || result.decision === "deny")) this.state.matchedDecisions.set(result.grantId, Math.min(Number.MAX_SAFE_INTEGER, (this.state.matchedDecisions.get(result.grantId) ?? 0) + 1));
    return result;
  }
  private match(req: PermissionRequest, auditRequired: boolean, denialsOnly = false): GrantAuthorization {
    if (!this.active) return { decision: "deny", viewExpired: true };
    if (this.allowedTools !== undefined && !this.allowedTools.has(req.tool)) return { decision: "deny" };
    if (separateConsent(req)) return { decision: "ask" };
    if (this.state.auditBlocked || (auditRequired && this.state.pending.length > 0)) return { decision: "deny", auditBlocked: true };
    for (const grant of this.state.grants.values()) {
      // Fresh consent honors any matching deny; ordinary first-match ordering is unchanged.
      if (denialsOnly && grant.decision !== "deny") continue;
      if (!this.visible(grant)) continue;
      if (!permissionGrantCoversRequest(grant, req)) continue;
      return { decision: grant.decision, grantId: grant.id };
    }
    return { decision: "ask" };
  }
}
