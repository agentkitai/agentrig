import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { ownedProcess } from "../owned-process.js";
import type { TuiController, TuiState } from "./controller.js";

export const NotificationMode = z.enum(["off", "bell", "desktop", "both"]);
export const NotificationIdleSeconds = z.number().int().min(1).max(3600);
export interface NotificationOptions { notifications?: z.infer<typeof NotificationMode>; notificationIdleSeconds?: number; headless?: boolean }
type Kind = "permission" | "question" | "supervisor" | "end";
const messages: Record<Kind, string> = { permission: "A permission answer is needed", question: "A question answer is needed",
  supervisor: "A supervisor answer is needed", end: "The session ended" };
export type DesktopDelivery = (kind: Kind, signal: AbortSignal) => Promise<void>;

/** Fixed host UI operations, never task/model/config strings or shell interpolation. */
export function desktopCommand(platform: string, kind: Kind): { program: string; args: string[] } | undefined {
  if (platform === "darwin") return { program: "/usr/bin/osascript", args: ["-e", `display notification "${messages[kind]}" with title "AgentRig"`] };
  if (platform === "linux") return { program: "/usr/bin/notify-send", args: ["--app-name=AgentRig", "--", "AgentRig", messages[kind]] };
  return undefined;
}
interface DesktopDependencies {
  platform: string;
  check(program: string): Promise<void>;
  run: typeof ownedProcess;
  env: NodeJS.ProcessEnv;
}
/** Internal test injection only, never populated from project/model data. */
export function desktopDelivery(deps: DesktopDependencies): DesktopDelivery { return async (kind, signal) => {
  const command = desktopCommand(deps.platform, kind);
  if (!command) throw Error("desktop notification unavailable");
  await deps.check(command.program); signal.throwIfAborted();
  // Only the GUI session's routing environment, not provider credentials or repository paths.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG"])
    if (deps.env[key] !== undefined) env[key] = deps.env[key];
  await deps.run(command.program, command.args, { cwd: "/", env, signal, timeoutMs: 2000, maxBytes: 4096,
    errorMessage: "desktop notification unavailable" });
}; }
export const deliverDesktop = desktopDelivery({ platform: process.platform, env: process.env, run: ownedProcess,
  async check(program) { const stat = await lstat(program);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("desktop notification unavailable");
    await access(program, constants.X_OK);
  },
});

interface Candidate { kind: Kind; identity: unknown; notified: boolean }
export interface NotificationHost {
  stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean; write(text: string): unknown };
  desktop?: DesktopDelivery; now?: () => number;
}
export interface Notifications { input(): void; close(): Promise<void> }

/** Mount-scoped observer. Idle is local input inactivity, not observed OS window focus. */
export function mountNotifications(controller: TuiController, options: NotificationOptions, host: NotificationHost): Notifications {
  const mode = NotificationMode.parse(options.notifications ?? "off");
  const idleMs = NotificationIdleSeconds.parse(options.notificationIdleSeconds ?? 30) * 1000;
  if (options.headless === true || mode === "off" || host.stdin.isTTY !== true || host.stdout.isTTY !== true)
    return { input() {}, async close() {} };
  const now = host.now ?? (() => performance.now());
  let lastInput = now(), lastDelivery = -Infinity, closed = false, warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let deliveryAbort: AbortController | undefined;
  let delivering: Candidate | undefined;
  let state = controller.snapshot();
  let activeSession: string | null = state.status === "running" ? state.sessionId : null;
  let end: Candidate | undefined;
  let candidates: Candidate[] = [];
  const current = (): { kind: Kind; identity: unknown }[] => {
    // Match the input arbitration: permission first, question second, supervisor last.
    return [...(state.pending ? [{ kind: "permission" as const, identity: state.pending.resolve }] : []),
      ...(state.question ? [{ kind: "question" as const, identity: state.question.resolve }] : []),
      ...(state.escalation ? [{ kind: "supervisor" as const, identity: state.escalation.resolve }] : []), ...(end ? [end] : [])];
  };
  const visible = () => { const all = current(); return all.filter((c, index) => index === 0 || c.kind === "end"); };
  const eligible = (c: Candidate) => visible().some(live => live.kind === c.kind && live.identity === c.identity);
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (closed || running || !candidates.some(c => !c.notified && eligible(c))) return;
    const wait = Math.max(lastInput + idleMs, lastDelivery + 2000) - now();
    timer = setTimeout(deliver, Math.max(0, wait));
  };
  const update = (next: TuiState): void => {
    state = next;
    if (state.status === "running") { activeSession = state.sessionId; end = undefined; }
    else if (activeSession !== null) {
      if (state.sessionId === activeSession && now() - lastInput >= idleMs)
        end = { kind: "end", identity: activeSession, notified: false };
      activeSession = null;
    }
    candidates = current().map(c => candidates.find(old => old.kind === c.kind && old.identity === c.identity) ?? { ...c, notified: false });
    if (delivering && !eligible(delivering)) deliveryAbort?.abort();
    schedule();
  };
  function deliver(): void {
    timer = undefined;
    if (closed || running) return;
    // Input/state changes during scheduling cannot grant stale delivery authority.
    if (now() - lastInput < idleMs || now() - lastDelivery < 2000) { schedule(); return; }
    const candidate = candidates.find(c => !c.notified && eligible(c));
    if (!candidate) return;
    candidate.notified = true; lastDelivery = now();
    if (mode === "bell" || mode === "both") host.stdout.write("\u0007");
    if (mode === "desktop" || mode === "both") {
      const signalOwner = new AbortController(); deliveryAbort = signalOwner; delivering = candidate;
      const deadline = setTimeout(() => signalOwner.abort(), 2000);
      running = Promise.resolve().then(() => {
        signalOwner.signal.throwIfAborted();
        return (host.desktop ?? deliverDesktop)(candidate.kind, signalOwner.signal);
      }).catch(() => {
        if (!closed && !signalOwner.signal.aborted && !warned) { warned = true; controller.print("Desktop notifications unavailable; terminal policy is unchanged.", "system"); }
      }).finally(() => { clearTimeout(deadline); deliveryAbort = undefined; delivering = undefined; running = undefined; schedule(); });
    } else schedule();
  }
  const unsubscribe = controller.subscribe(update);
  update(state);
  return {
    input() { lastInput = now(); end = undefined; deliveryAbort?.abort(); update(controller.snapshot()); },
    async close() { closed = true; unsubscribe(); if (timer !== undefined) clearTimeout(timer); deliveryAbort?.abort(); await running; },
  };
}
