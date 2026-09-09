import { z } from "zod";

/** Config-only schemas: resolving defaults must not load desktop process or TUI machinery. */
export const NotificationMode = z.enum(["off", "bell", "desktop", "both"]);
export const NotificationIdleSeconds = z.number().int().min(1).max(3600);
