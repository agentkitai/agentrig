import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentConfig } from "./agent.js";
import type { HarnessEvent, PermissionRequest } from "./events.js";
import { EventPayload, TOOL_EMITTABLE_EVENTS, TOOL_EMIT_SOURCES } from "./events.js";
import type { ContentBlock, ContentTrust, InstructionContext } from "./messages.js";
import { prepareResultTrust } from "./content-provenance.js";
import type { AnyTool, ToolContext } from "./tool.js";
import { SandboxDeniedError, withSandboxPolicy } from "./sandbox.js";
import { outsideSandbox } from "./sandbox-providers.js";
import { contentHash } from "./session-store.js";
import { mergePatches, type AttributedHookResult, type Hook, type HookPoint, type runHooks } from "./hooks.js";
import { combinedContext, ADVISORY_CONTEXT } from "./context-principals.js";
import { expansionSurface, type externalExpansion } from "./external-expansion.js";
import { isCheckpointerHook } from "./checkpointer.js";
import { outputArtifactMarker } from "./tools/read-output.js";
import { bound, DISPLAY_CAP, safeSliceEnd } from "./tools/shared.js";

export interface ReplanState { reason: string | null; refusals: number }
export type SessionHook = (point: HookPoint, ctx: Omit<Parameters<typeof runHooks>[2], "signal">, selectedHooks?: Hook[], failClosed?: boolean) => Promise<AttributedHookResult>;

function displayContext(result: AttributedHookResult): InstructionContext | undefined {
  const index = result.patches.map((patch, index) => typeof patch === "string" ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
  const contexts = [...(index < 0 ? [] : [result.patchContexts?.[index] ?? ADVISORY_CONTEXT]),
    ...result.injects.map((_text, index) => result.injectContexts?.[index] ?? ADVISORY_CONTEXT)];
  // Inject-only changes retain the tool's own text. A delegated note cannot lend that text
  // instruction authority; only a complete replacement is solely the hook's contribution.
  if (index < 0 && result.injects.length > 0) contexts.unshift(ADVISORY_CONTEXT);
  return contexts.length === 0 ? undefined : combinedContext(contexts);
}
type Emit = (payload: EventPayload) => Promise<HarnessEvent>;
interface ToolExecutionContext {
  expansion?: ReturnType<typeof externalExpansion>;
  config: Pick<AgentConfig, "hooks" | "origin" | "permissions" | "permissionGrants" | "onAsk" | "sandbox" | "store" | "trustedProjectRoot">;
  id: string;
  grantSessionId?: string;
  cwd: string;
  turns: number;
  toolsByName: ReadonlyMap<string, AnyTool>;
  hasPlanTool: boolean;
  replan: ReplanState;
  emit: Emit;
  emitFromTool: (name: string, callSeq: number) => (payload: EventPayload) => void;
  hook: SessionHook;
  signal: AbortSignal;
  endSignal: AbortSignal;
  raceAbort: <T>(work: Promise<T>, label: string) => Promise<T>;
  now: () => number;
  isEnded: () => boolean;
}

/** The tool that satisfies a replan gate. Named once so core and the gate cannot drift apart. */
export const PLAN_TOOL = "update_plan";

/**
 * Refusals before a replan gate releases itself. Small on purpose: the gate exists to interrupt,
 * not to stop. If two refusals have not produced a plan, a third will not either.
 */
export const MAX_REPLAN_REFUSALS = 2;

interface OverflowResult {
  display: string;
  output?: string;
  /** Complete-output cursor corresponding to a prefix preview; absent for headers/summaries. */
  prefixLimit?: number;
}

/** Bound every tool, and turn both explicit and forgotten representational overflow into artifacts. */
function overflowResult(result: {
  display: string;
  output: unknown;
  truncated?: boolean;
  fullDisplay?: string;
  displayPrefixChars?: number;
}): OverflowResult {
  const explicit = result.truncated === true && result.fullDisplay !== undefined && result.fullDisplay.length > 0
    ? result.fullDisplay
    : undefined;
  if (explicit !== undefined && explicit !== result.display) {
    const prefixLimit = Number.isSafeInteger(result.displayPrefixChars) && result.displayPrefixChars! >= 0 &&
      result.displayPrefixChars! < explicit.length
      ? result.displayPrefixChars
      : undefined;
    return {
      display: bound(result.display).display,
      output: explicit,
      ...(prefixLimit === undefined ? {} : { prefixLimit }),
    };
  }
  const bounded = bound(result.display);
  return bounded.truncated
    ? { display: bounded.display, output: result.display, prefixLimit: bounded.shown }
    : { display: bounded.display };
}

/** Keep a directly pageable artifact handle inside a caller-selected model-facing display bound. */
function displayWithOutputHandle(
  display: string,
  output: string,
  seq: number,
  prefixLimit: number | undefined,
  cap = DISPLAY_CAP,
): string {
  const preview = prefixLimit === undefined ? display : output;
  let visible = Math.min(prefixLimit ?? preview.length, cap);
  let marker = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cursor = prefixLimit === undefined ? 0 : visible;
    const nextTo = safeSliceEnd(output, Math.min(output.length, cursor + DISPLAY_CAP));
    marker = outputArtifactMarker(seq, cursor, nextTo, output.length);
    const nextVisible = safeSliceEnd(
      preview,
      Math.min(prefixLimit ?? preview.length, Math.max(0, cap - marker.length)),
    );
    if (nextVisible === visible) break;
    visible = nextVisible;
  }
  const cursor = prefixLimit === undefined ? 0 : visible;
  const nextTo = safeSliceEnd(output, Math.min(output.length, cursor + DISPLAY_CAP));
  marker = outputArtifactMarker(seq, cursor, nextTo, output.length);
  return `${preview.slice(0, visible)}${marker}`;
}

/** Tool events cross a registered-name authority boundary before the shared append chain. */
export function createToolEmitterFactory(emit: Emit, isEnded: () => boolean) {
  // A tool the abort race orphaned may still emit after session.end; those events are dropped
  // so the log's last event is always session.end.
  // A factory rather than one shared closure: the loop binds the executing tool's registered name
  // (never a name the payload claims), so the gate can hold tools to the events that are theirs.
  const emitFromTool = (toolName: string, callSeq: number) => (payload: EventPayload): void => {
    if (isEnded()) return;
    // A tool's emit is untrusted input, so it is gated on THREE axes, mirroring record():
    //  1. TYPE — a tool may emit only the informational/state kinds tools legitimately produce
    //     (TOOL_EMITTABLE_EVENTS). A forged permission.decision, session.end, or supervisor
    //     record is not one of them.
    //  2. SOURCE — an emittable type that carries authority is held to its one legitimate emitter
    //     (TOOL_EMIT_SOURCES): `plan.updated` releases the force_replan gate below and rewrites the
    //     scope the drift detector enforces, `subagent.*` asserts a child session exists. Any tool
    //     could otherwise emit one `plan.updated` and shrug off the intervention PLAN §4.2 promises
    //     cannot be ignored (issue #67).
    //  3. SHAPE — even an allowed type must be a well-formed EventPayload. The store appends with a
    //     bare JSON.stringify and `read` re-parses with HarnessEvent.parse, which THROWS on a bad
    //     line; raw/ is immutable, so one malformed `{type:"file.changed"}` would permanently break
    //     `sessions show`, resume, and ingest for the session (the same corruption record() guards).
    // Any failure is dropped and reported, never appended — the log stays readable and faithful
    // whatever a tool (a buggy one, or one forwarding hostile content) tries to write.
    const reject = (why: string): void => {
      const type = typeof (payload as { type?: unknown })?.type === "string" ? (payload as { type: string }).type : "unknown";
      void emit({ type: "error", message: `the "${toolName}" tool tried to emit a "${type}" event, ${why}; dropped`, fatal: false });
    };
    if (!TOOL_EMITTABLE_EVENTS.has(payload.type)) return reject("which tools may not emit");
    const soleEmitter = TOOL_EMIT_SOURCES.get(payload.type);
    if (soleEmitter !== undefined && soleEmitter !== toolName) {
      return reject(`which only the "${soleEmitter}" tool may emit`);
    }
    const parsed = EventPayload.safeParse(payload);
    if (!parsed.success) return reject("which is malformed and would corrupt the log");
    void emit(parsed.data.type === "file.changed" ? { ...parsed.data, toolCallSeq: callSeq } : parsed.data);
  };

  return emitFromTool;
}

export async function executeTool(tu: { id: string; name: string; input: unknown }, context: ToolExecutionContext): Promise<ContentBlock> {
  const { config, id, cwd, turns, toolsByName, hasPlanTool, replan, emit, emitFromTool, hook, signal, endSignal, raceAbort, now, isEnded } = context;
  const resultBlock = (content: string, isError: boolean, trust: ContentTrust = "external", context?: InstructionContext): ContentBlock =>
    isError
      ? { type: "tool_result", toolUseId: tu.id, content, isError: true, trust, ...(context === undefined ? {} : { context }) }
      : { type: "tool_result", toolUseId: tu.id, content, trust, ...(context === undefined ? {} : { context }) };

  const tool = toolsByName.get(tu.name);
  if (!tool) {
    await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
    await emit({ type: "tool.result", id: tu.id, ok: false, display: `unknown tool: ${tu.name}`, durationMs: 0 });
    return resultBlock(`unknown tool: ${tu.name}`, true);
  }

  // The replan gate: everything except planning is refused while it is up — but it is
  // self-limiting. A gate that could never be released (no `update_plan` in the tool list,
  // an agent that will not call it, permissions that deny it) would burn the whole budget on
  // refusals, which is a worse failure than whatever the supervisor was trying to catch. So
  // it opens itself after MAX_REPLAN_REFUSALS and says why.
  if (replan.reason !== null && tu.name !== PLAN_TOOL) {
    replan.refusals += 1;
    if (replan.refusals > MAX_REPLAN_REFUSALS || !hasPlanTool) {
      const why = hasPlanTool
        ? `after ${replan.refusals - 1} refusals`
        : `this session has no ${PLAN_TOOL} tool, so the gate could never be satisfied`;
      await emit({
        type: "error",
        message: `replan gate released ${why}; continuing without a fresh plan`,
        fatal: false,
      });
      replan.reason = null;
      replan.refusals = 0;
    } else {
      const display =
        `blocked: the supervisor requires a fresh plan before more tool calls (${replan.reason}). ` +
        `Call ${PLAN_TOOL} with your revised plan, then continue.`;
      await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
      await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: 0 });
      // The platform assembles this reminder around an advisory supervisor reason.
      return resultBlock(display, true, "external", ADVISORY_CONTEXT);
    }
  }

  const parsed = tool.inputSchema.safeParse(tu.input);
  if (!parsed.success) {
    const display = `invalid input for ${tu.name}: ${parsed.error.message}`;
    await emit({ type: "tool.call", id: tu.id, name: tu.name, input: tu.input, inputHash: contentHash(tu.input) });
    await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: 0 });
    return resultBlock(display, true);
  }
  // pre_tool: sees the PARSED input, so a hook reasons about typed data rather than raw JSON.
  // A `modify` patch is re-validated against the tool's own schema below — a hook is
  // third-party code, so its patch is a proposal, not an instruction.
  let input = parsed.data;
  let inputContext: InstructionContext | undefined;
  {
    const h = await hook("pre_tool", {
      sessionId: id,
      cwd,
      turn: turns,
      tool: { name: tu.name, input },
    });
    if (h.denied !== undefined) {
      // no `tool.call` — matching the permission-deny path exactly. A phantom call for
      // something that never ran feeds the stall detector's productivity count and the loop
      // detector's inputHash tally, so the two deny paths must look the same downstream.
      await emit({ type: "tool.denied", id: tu.id, name: tu.name });
      return resultBlock(`blocked by hook: ${h.denied}`, true);
    }
    if (h.patches.length > 0) {
      const merged = tool.inputSchema.safeParse(mergePatches(input, h.patches));
      if (merged.success) {
        // This API shallow-merges inputs, not whole-input instruction replacement. Retained
        // model fields must not borrow delegation, and a no-op has no actual contribution.
        if (!isDeepStrictEqual(input, merged.data)) {
          context.expansion?.hookInput();
          const source = combinedContext(h.patches.map((_patch, index) => h.patchContexts?.[index] ?? ADVISORY_CONTEXT));
          inputContext = { principal: source.principal, authority: "advisory" };
        }
        input = merged.data;
      }
      else {
        await emit({
          type: "error",
          message: `hook patch for ${tu.name} did not match its schema; using the original input`,
          fatal: false,
        });
      }
    }
  }

  const permClass = typeof tool.permission === "function" ? tool.permission(input) : tool.permission;
  const declaredPaths = tool.paths?.(input);
  const operation = tool.operation?.(input);
  const permReq: PermissionRequest = {
    tool: tu.name,
    input,
    class: permClass,
    cwd,
    ...(declaredPaths === undefined ? {} : { paths: declaredPaths }),
    ...(operation === undefined ? {} : { operation }),
    // whose session this is, when it is not the one a human is watching. Set on the config by
    // whoever built the session (the subagent tool's `childConfig`), never by a tool or by
    // the model — an ask that can name its own origin can lie about it.
    ...(config.origin === undefined ? {} : { origin: config.origin }),
  };
  const surface = context.expansion === undefined ? undefined
    : await raceAbort(expansionSurface(permReq, signal), "permission surface classification");
  const freshExpansion = context.expansion?.needs(surface) === true;
  if (freshExpansion) {
    permReq.origin = "external-input-expansion";
    permReq.expansionSurface = surface;
    if (config.origin !== undefined) permReq.sourceOrigin = config.origin;
  }
  await emit({ type: "permission.request", req: permReq });
  if (config.permissionGrants !== undefined && (isEnded() || signal.aborted)) return resultBlock("aborted before permission authorization", true);
  let decision = await config.permissions.decide(permReq);
  if (freshExpansion && decision !== "deny") decision = "ask";
  await config.permissionGrants?.flush(emit);
  if (decision === "ask" && config.permissionGrants !== undefined && !freshExpansion) {
    decision = config.permissionGrants.context.sessionId === context.grantSessionId ? config.permissionGrants.decide(permReq, true) : "deny";
  }
  await emit({ type: "permission.decision", d: decision });
  if (decision === "ask") {
    decision = config.onAsk === undefined ? "deny" : freshExpansion
      ? await raceAbort(Promise.resolve(config.onAsk(permReq)), "fresh external-input approval").catch(() => "deny" as const)
      : await config.onAsk(permReq);
    if (freshExpansion && (decision !== "allow" || signal.aborted || isEnded())) decision = "deny";
    if (config.permissionGrants !== undefined && (isEnded() || signal.aborted)) return resultBlock("aborted while awaiting permission", true);
    await config.permissionGrants?.flush(emit);
    if (config.permissionGrants !== undefined && config.permissionGrants.context.sessionId !== context.grantSessionId) decision = "deny";
    await emit({ type: "permission.decision", d: decision });
  }
  if (freshExpansion) {
    await emit({ type: "permission.expansion", id: tu.id, name: tu.name, surface: surface!,
      decision: decision === "allow" ? "allow" : "deny",
      ...(config.origin === undefined ? {} : { sourceOrigin: config.origin }) });
  }
  if (decision === "deny") {
    await emit({ type: "tool.denied", id: tu.id, name: tu.name });
    return resultBlock(`permission denied: ${tu.name} [${permClass}]`, true);
  }
  if (config.permissionGrants !== undefined && (isEnded() || signal.aborted)) return resultBlock("aborted before tool execution", true);

  const checkpointers = (config.hooks ?? []).filter(isCheckpointerHook);
  const toolEffect = checkpointers.length === 0 ? "read-only" : typeof tool.effects === "function" ? tool.effects(input) : (tool.effects ?? "workspace");
  if (checkpointers.length > 0) {
    const checkpoint = await hook("pre_tool", {
      sessionId: id, cwd, turn: turns, tool: { name: tu.name, input }, permission: permClass,
      toolEffect,
      hasBackgroundWork: () => [...toolsByName.values()].some(t => t.hasBackgroundWork?.()),
      checkpointExcludes: [await realpath(config.store.root)],
      emitCheckpoint: async (event) => {
        if (isEnded() || signal.aborted) throw new Error("checkpoint session ended/aborted");
        await emit(EventPayload.parse(event));
      },
    }, checkpointers, true);
    if (checkpoint.denied !== undefined) {
      await emit({ type: "tool.denied", id: tu.id, name: tu.name });
      return resultBlock(`checkpoint failed; tool blocked: ${checkpoint.denied}`, true);
    }
  }
  if (checkpointers.length > 0 && signal.aborted) return resultBlock("aborted before tool execution", true);
  const callEvent = await emit({ type: "tool.call", id: tu.id, name: tu.name, input, inputHash: contentHash(input),
    ...(inputContext === undefined ? {} : { context: inputContext }) });
  const ctx: ToolContext = {
    cwd,
    sessionId: id,
    // bound to the REGISTERED tool's name (the one resolved from toolsByName), which is also
    // what tool.call recorded — not anything the tool or model could claim later
    emit: emitFromTool(tool.name, callEvent.seq),
    signal: signal,
    endSignal: endSignal,
  };
  const t0 = now();
  let sandboxDenialRecorded = false;
  let sandboxRetryDenied = false;
  try {
    let finishTrust: () => Promise<ContentTrust> = async () => tool.resultSource === "external" ? "external" : "tool-output";
    if (tool.resultSource !== undefined && tool.resultSource !== "external") {
      finishTrust = await raceAbort(prepareResultTrust(tool, input, cwd, config.trustedProjectRoot), "tool provenance");
      signal.throwIfAborted();
    }
    const command = () => {
      signal.throwIfAborted();
      context.expansion?.dispatched(surface);
      return tool.execute(input, ctx);
    };
    // Approval and sandboxing are independent axes: only an approved call reaches the sandbox,
    // and selecting `none` still traverses the provider seam so providers own mode semantics.
    const prepared = config.sandbox !== undefined && config.sandbox.mode !== "none" && tool.sandbox !== "compatible"
      ? async () => { throw new SandboxDeniedError(`tool ${tool.name} has no sandbox-compatible execution path; running it requires explicit outside-sandbox approval`); }
      : config.sandbox === undefined
      ? command
      : config.sandbox.provider.prepare(command, {
          mode: config.sandbox.mode,
          cwd,
          ...(config.sandbox.network === undefined ? {} : { network: config.sandbox.network }),
        });
    let r;
    try {
      r = await raceAbort(withSandboxPolicy(
        config.sandbox === undefined || config.sandbox.mode === "none" ? undefined : {
          mode: config.sandbox.mode, cwd,
          ...(config.sandbox.network === undefined ? {} : { network: config.sandbox.network }),
        }, prepared,
      ), `tool ${tool.name}`);
    } catch (err) {
      if (config.sandbox === undefined || !(err instanceof SandboxDeniedError)) throw err;

      const reason = bound(err.message).display;
      await emit({
        type: "sandbox.denied",
        id: tu.id,
        name: tu.name,
        mode: config.sandbox.mode,
        reason,
      });
      sandboxDenialRecorded = true;

      // A sandbox grant is not a standing tool permission: it crosses a second security axis and
      // must be answered explicitly. The retry bypasses only the sandbox, not input validation,
      // hooks, logging, or the original permission decision, and this non-looping branch gives
      // one call exactly one opportunity to run outside the boundary.
      const escalationReq: PermissionRequest = { ...permReq, origin: "sandbox-escalation" };
      await emit({ type: "permission.request", req: escalationReq });
      await emit({ type: "permission.decision", d: "ask" });
      const escalationDecision = config.onAsk === undefined
        ? "deny"
        : await config.onAsk(escalationReq);
      await emit({ type: "permission.decision", d: escalationDecision });
      if (escalationDecision !== "allow") {
        sandboxRetryDenied = true;
        throw err;
      }

      // Deliberately call the original deferred command, never `prepared`, and never catch this
      // as another escalation. A provider-shaped error from this one retry is an ordinary tool
      // failure because no sandbox was active for it.
      r = await raceAbort(outsideSandbox(command), `tool ${tool.name} outside sandbox`);
    }
    const ok = r.isError !== true;
    const overflow = overflowResult(r);
    const resultEvent = await emit({
      type: "tool.result",
      id: tu.id,
      ok,
      display: overflow.display,
      durationMs: now() - t0,
      permission: permClass,
      toolCallSeq: callEvent.seq,
      ...(overflow.output === undefined ? {} : { output: overflow.output, truncated: true }),
      ...(r.truncated === true && !(typeof r.fullDisplay === "string" && r.fullDisplay.length > 0)
        ? { outputIncomplete: true } : {}),
    });
    const modelDisplay = overflow.output === undefined
      ? overflow.display
      : displayWithOutputHandle(
          overflow.display,
          overflow.output,
          resultEvent.seq,
          overflow.prefixLimit,
        );
    if (overflow.output !== undefined) {
      // The raw result above preserves the tool's own display. This additive event records the
      // different bounded handle-bearing display the model actually consumes.
      await emit({ type: "tool.result.patched", id: tu.id, by: "core:output-overflow", display: modelDisplay });
    }

    // post_tool: a hook may rewrite what the MODEL sees (redaction, summarising a huge
    // output) or append to it. The `tool.result` event above is already written, so the log
    // keeps what the tool actually returned — a hook can shape the conversation without
    // being able to rewrite history.
    const h = await hook("post_tool", {
      sessionId: id,
      cwd,
      turn: turns,
      tool: { name: tu.name, input },
      // `display` includes the immutable-log handle when output overflowed; `output` remains
      // the tool's own value, which is very often not a string.
      result: { ok, display: modelDisplay, output: r.output },
    });
    for (const bad of h.patches.filter((p) => typeof p !== "string")) {
      await emit({
        type: "error",
        message: `post_tool patch for ${tu.name} must be a string (got ${typeof bad}); ignoring`,
        fatal: false,
      });
    }
    const replaced = h.patches.filter((p): p is string => typeof p === "string").at(-1);
    let body = modelDisplay;
    if (replaced !== undefined || h.injects.length > 0) {
      // An ordinary bounded result keeps every code unit and the injection shrinks to the
      // remaining space. An overflow artifact or replacement shares the frame: half remains
      // available for guidance and half for result context/the recovery handle.
      const rawInjected = h.injects.join("\n");
      const availableAfterResult = Math.max(0, DISPLAY_CAP - modelDisplay.length - 1);
      const injectedBudget = rawInjected === ""
        ? 0
        : overflow.output !== undefined || replaced !== undefined
          ? Math.floor(DISPLAY_CAP / 2)
          : availableAfterResult > 0
            ? availableAfterResult
            : Math.min(Math.floor(DISPLAY_CAP / 2), rawInjected.length);
      const injected = injectedBudget === 0 ? "" : bound(rawInjected, injectedBudget).display;
      const separator = injected === "" ? "" : "\n";
      const baseBudget = DISPLAY_CAP - separator.length - injected.length;
      const base = replaced !== undefined
        ? bound(replaced, baseBudget).display
        : overflow.output !== undefined
          ? displayWithOutputHandle(
              overflow.display,
              overflow.output,
              resultEvent.seq,
              overflow.prefixLimit,
              baseBudget,
            )
          : bound(modelDisplay, baseBudget).display;
      // Keep the strict recovery marker last even when guidance is injected; stale-result
      // eviction can then preserve the real core marker rather than marker-shaped tool text.
      body = overflow.output !== undefined && replaced === undefined && injected !== ""
        ? `${injected}${separator}${base}`
        : `${base}${separator}${injected}`;
      // the log keeps what the tool returned; this records that a hook changed what the
      // model consumed, so the two can never diverge unobserved
      await emit({
        type: "tool.result.patched",
        id: tu.id,
        by: "post_tool",
        display: body,
        mode: replaced === undefined ? "inject" : "modify",
      });
    }
    // Hook-shaped display changes have unknown ancestry until R13d assigns principals.
    const trust = !ok || replaced !== undefined || h.injects.length > 0 ? "external"
      // The authoritative result is already emitted. An abort here degrades provenance;
      // it must not enter the execution-failure catch and emit a duplicate result.
      : await raceAbort(finishTrust(), "tool provenance").catch(() => "external" as const);
    return resultBlock(body, !ok, trust, displayContext(h));
  } catch (err) {
    const sandboxDenied = err instanceof SandboxDeniedError && (
      sandboxRetryDenied || (config.sandbox !== undefined && !sandboxDenialRecorded)
    );
    const rawReason =
      signal.aborted && err instanceof DOMException && err.name === "AbortError"
        ? "aborted"
        : err instanceof Error
          ? err.message
          : String(err);
    // A throw is an unexpected failure, not a successful complete rendering: bound it but do
    // not persist its unbounded message as an artifact. Still run post_tool so redaction hooks
    // cover errors exactly as they cover ordinary tool results.
    const reason = bound(rawReason).display;
    const display = bound(sandboxDenied ? `sandbox denied: ${rawReason}` : rawReason).display;
    if (sandboxDenied && config.sandbox !== undefined && !sandboxDenialRecorded) {
      await emit({
        type: "sandbox.denied",
        id: tu.id,
        name: tu.name,
        mode: config.sandbox.mode,
        reason,
      });
    }
    await emit({ type: "tool.result", id: tu.id, ok: false, display, durationMs: now() - t0 });
    const h = await hook("post_tool", {
      sessionId: id,
      cwd,
      turn: turns,
      tool: { name: tu.name, input },
      result: { ok: false, display, output: undefined },
    });
    for (const bad of h.patches.filter((patch) => typeof patch !== "string")) {
      await emit({
        type: "error",
        message: `post_tool patch for ${tu.name} must be a string (got ${typeof bad}); ignoring`,
        fatal: false,
      });
    }
    const replaced = h.patches.filter((patch): patch is string => typeof patch === "string").at(-1);
    const rawInjected = h.injects.join("\n");
    const availableAfterError = Math.max(0, DISPLAY_CAP - display.length - 1);
    const injectedBudget = rawInjected === ""
      ? 0
      : availableAfterError > 0
        ? availableAfterError
        : Math.min(Math.floor(DISPLAY_CAP / 2), rawInjected.length);
    const injected = injectedBudget === 0 ? "" : bound(rawInjected, injectedBudget).display;
    const separator = injected === "" ? "" : "\n";
    const base = bound(replaced ?? display, DISPLAY_CAP - separator.length - injected.length).display;
    const body = `${base}${separator}${injected}`;
    if (replaced !== undefined || h.injects.length > 0) {
      await emit({
        type: "tool.result.patched",
        id: tu.id,
        by: "post_tool",
        display: body,
        mode: replaced === undefined ? "inject" : "modify",
      });
    }
    return resultBlock(body, true, "external", displayContext(h));
  } finally {
    for (const checkpointer of checkpointers) {
      await checkpointer.afterTool({
        point:"post_tool",sessionId:id,cwd,turn:turns,toolEffect,
        signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)]),
        hasBackgroundWork:()=>[...toolsByName.values()].some(t=>t.hasBackgroundWork?.()),
        checkpointExcludes:[await realpath(config.store.root)],
      }).catch((error:unknown)=>emit({type:"error",message:`checkpoint ownership failed: ${String(error)}`,fatal:false}));
    }
  }
}
