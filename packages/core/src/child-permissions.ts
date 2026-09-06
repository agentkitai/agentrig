import type { PermissionGrantRegistry } from "./permission-grants.js";

// Internal live identity, never an origin string, event, option copied by a model, or tool input.
const views = new WeakMap<object, { view: PermissionGrantRegistry | undefined; session?: string; task?: string }>();
export function bindPermissionView(context: object, view: PermissionGrantRegistry | undefined): void {
  const live = view?.context;
  views.set(context, { view, ...(live?.sessionId === undefined ? {} : { session: live.sessionId }),
    ...(live?.taskId === undefined ? {} : { task: live.taskId }) });
}
export function childPermissionView(context: object, configured: PermissionGrantRegistry | undefined): PermissionGrantRegistry | undefined {
  if (!views.has(context)) {
    if (configured !== undefined) throw new Error("unbound tool context cannot inherit permission grants");
    return undefined;
  }
  const bound = views.get(context)!;
  if (bound.view !== undefined && (bound.session !== bound.view.context.sessionId || bound.task !== bound.view.context.taskId)) {
    throw new Error("tool permission context expired");
  }
  return bound.view?.childView();
}
