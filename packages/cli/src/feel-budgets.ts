import { z } from "zod";

/** E1 reference traces, not a model capability score. R17d may lower these, never silently raise them. */
export const E1_FEEL_LIMITS = {
  A1: { prompts: 2, turns: 4 }, A2: { prompts: 2, turns: 4 },
  A3: { prompts: 3, turns: 5 }, A4: { prompts: 2, turns: 5 },
  X1: { prompts: 2, turns: 4 }, X2: { prompts: 2, turns: 4 },
  X3: { prompts: 2, turns: 4 }, X4: { prompts: 2, turns: 4 },
} as const;
export const FEEL_LIMITS = { startupMs: 400, firstByteTicks: 1, frameCpuMs: 16 } as const;
const measurement = z.number().finite().nonnegative();
export const FeelStreamMeasurement = z.object({
  firstByteToEventMs: measurement, firstByteToEventTicks: measurement.int(),
  firstByteToVisibleMs: measurement, firstByteToVisibleTicks: measurement.int(),
  frameCount: z.literal(16), maxFrameCpuMs: measurement, meanFrameCpuMs: measurement,
});
export const FeelTaskMeasurement = z.object({
  task: z.enum(["A1", "A2", "A3", "A4", "X1", "X2", "X3", "X4"]),
  permissionPrompts: measurement.int(), turnsToDone: measurement.int().positive(),
  reason: z.literal("done"), sessionEnd: z.literal("session.end"), sessionId: z.string().min(1),
  check: z.object({ behavior: z.literal("PASS"), outcome: z.enum(["PASS", "BLOCKED"]) }),
});
export const FeelReport = z.object({
  measuredAt: z.string().datetime(), platform: z.string(), node: z.string(),
  coldStartMs: measurement, stream: FeelStreamMeasurement,
  tasks: z.array(FeelTaskMeasurement).length(8),
});
export type FeelReport = z.infer<typeof FeelReport>;

export function assertColdStartBudget(ms: unknown): number {
  const value = measurement.parse(ms);
  if (value >= FEEL_LIMITS.startupMs) throw new Error(`cold start ${value.toFixed(3)} ms exceeds < ${FEEL_LIMITS.startupMs} ms`);
  return value;
}

export function assertFeelBudgets(input: unknown): FeelReport {
  const report = FeelReport.parse(input);
  assertColdStartBudget(report.coldStartMs);
  for (const ticks of [report.stream.firstByteToEventTicks, report.stream.firstByteToVisibleTicks]) {
    if (ticks > FEEL_LIMITS.firstByteTicks) throw new Error(`first byte latency ${ticks} ticks exceeds ${FEEL_LIMITS.firstByteTicks}`);
  }
  if (report.stream.maxFrameCpuMs >= FEEL_LIMITS.frameCpuMs) throw new Error(`frame CPU ${report.stream.maxFrameCpuMs} ms exceeds < ${FEEL_LIMITS.frameCpuMs} ms`);
  const ids = new Set(report.tasks.map(task => task.task));
  if (ids.size !== 8) throw new Error("all eight distinct E1 tasks must be measured");
  for (const task of report.tasks) {
    const limit = E1_FEEL_LIMITS[task.task];
    if (task.permissionPrompts > limit.prompts || task.turnsToDone > limit.turns) throw new Error(`${task.task}: ${task.permissionPrompts} prompts / ${task.turnsToDone} turns exceeds ${limit.prompts} / ${limit.turns}`);
    const expectedOutcome = task.task === "A4" || task.task === "X4" ? "BLOCKED" : "PASS";
    if (task.check.outcome !== expectedOutcome) throw new Error(`${task.task}: evaluator outcome changed; manual review cannot be fabricated`);
  }
  return report;
}

export function formatFeelBudgets(input: unknown): string[] {
  const report = FeelReport.parse(input);
  return [
    `info feel:reference — fake-provider measured reference, ${report.measuredAt}, ${report.platform}, ${report.node}; not a measurement of this machine or a live provider`,
    `info feel:startup — ${report.coldStartMs.toFixed(3)} ms cold process to visible prompt; budget < ${FEEL_LIMITS.startupMs} ms`,
    `info feel:first-byte — event ${report.stream.firstByteToEventTicks} ticks / ${report.stream.firstByteToEventMs.toFixed(3)} ms; visible stream ${report.stream.firstByteToVisibleTicks} ticks / ${report.stream.firstByteToVisibleMs.toFixed(3)} ms; budget <= ${FEEL_LIMITS.firstByteTicks} event-loop tick`,
    `info feel:frame — ${report.stream.meanFrameCpuMs.toFixed(3)} ms mean / ${report.stream.maxFrameCpuMs.toFixed(3)} ms max CPU per streamed event (${report.stream.frameCount} actual TUI frames, 2000-line scrollback); max budget < ${FEEL_LIMITS.frameCpuMs} ms`,
    ...report.tasks.map(task => `info feel:E1:${task.task} — ${task.permissionPrompts} permission prompts / ${task.turnsToDone} turns to done; budgets <= ${E1_FEEL_LIMITS[task.task].prompts} / ${E1_FEEL_LIMITS[task.task].turns}; behavior ${task.check.behavior}, evaluator ${task.check.outcome}`),
    "info feel:reproduce — pnpm feel:check; CI measures fresh values and fails on regression; E1 scripted reference traces are not autonomous model outcomes",
  ];
}
