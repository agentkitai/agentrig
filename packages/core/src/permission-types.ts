import { z } from "zod";

export const PermissionClass = z.enum(["read", "write", "exec", "network"]);
export type PermissionClass = z.infer<typeof PermissionClass>;
export const Decision = z.enum(["allow", "deny", "ask"]);
export type Decision = z.infer<typeof Decision>;
