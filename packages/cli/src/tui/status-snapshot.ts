import { sessionSpendSource, type Session } from "@agentkitai/agentrig-core";
import type { LadderSnapshot } from "@agentkitai/agentrig-supervisor";
import { readRunSpend } from "../usage.js";
import type { TuiController } from "./controller.js";

export interface StatusConfiguration { posture: "ask" | "yolo" | "unknown"; sandbox: string }
export interface StatusDetails extends StatusConfiguration {
  grants: number; auditBlocked: boolean; prompts: number;
  supervisor: LadderSnapshot | "off" | "unavailable" | "unknown";
  accounting: { state: "unknown" | "loading" | "unavailable" } |
    { state: "reported"; snapshot: Awaited<ReturnType<typeof readRunSpend>>; stale: boolean };
}

/** Mounted presentation only. One bounded ledger read at a time, never an authority fold. */
export function observeStatus(controller: TuiController, configuration: () => StatusConfiguration): () => Promise<void> {
  let stopped = false, publishing = false;
  let current: Session | undefined;
  let generation = 0, lastRead = -Infinity, readAt = 0;
  let pending: Promise<void> | undefined;
  let accounting: StatusDetails["accounting"] = { state: "unknown" };
  let prior = "";
  const refresh = (): void => {
    if (stopped || publishing) return;
    const state = controller.snapshot();
    const session = controller.statusSession();
    if (session !== current) { current = session; generation++; accounting = { state: "unknown" }; }
    const source = session === undefined ? undefined : sessionSpendSource(session);
    const now = Date.now();
    if (source !== undefined && pending === undefined && now - lastRead >= 5000) {
      lastRead = now;
      const epoch = generation;
      if (accounting.state !== "reported") accounting = { state: "loading" };
      pending = readRunSpend(source).then(snapshot => {
        if (stopped || epoch !== generation || controller.statusSession() !== session) return;
        readAt = Date.now(); accounting = { state: "reported", snapshot, stale: false };
      }, () => {
        if (!stopped && epoch === generation && controller.statusSession() === session) accounting = { state: "unavailable" };
      }).finally(() => { pending = undefined; refresh(); });
    }
    const grants = controller.permissionGrants.inspect();
    let config: StatusConfiguration;
    try { config = configuration(); } catch { config = { posture: "unknown", sandbox: "unknown" }; }
    const details: StatusDetails = { ...config, grants: grants.length,
      auditBlocked: grants.some(grant => grant.auditBlocked),
      prompts: Number(state.pending !== null) + state.queued + Number(state.question !== null) + state.queuedQuestions + Number(state.escalation !== null),
      supervisor: controller.statusSupervisor(),
      accounting: accounting.state === "reported" ? { ...accounting, stale: now - readAt >= 5000 } : accounting };
    const serialized = JSON.stringify(details);
    if (serialized !== prior) {
      prior = serialized; publishing = true;
      try { controller.setStatusDetails(details); } finally { publishing = false; }
    }
  };
  const unsubscribe = controller.subscribe(refresh);
  const timer = setInterval(refresh, 1000); timer.unref?.();
  return async () => { stopped = true; generation++; clearInterval(timer); unsubscribe(); await pending; };
}
