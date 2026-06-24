import type { BudgetState } from "./types.js";

export function monthKey(now = new Date()): string {
  return `BUDGET#${now.toISOString().slice(0, 7)}`;
}

export function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

export function canStart(params: { budget: BudgetState | undefined; requestedHours: number; monthlyRuntimeHoursLimit: number }): { ok: true } | { ok: false; reason: string } {
  const runtimeSeconds = params.budget?.runtimeSeconds ?? 0;
  const projectedHours = runtimeSeconds / 3600 + params.requestedHours;
  if (projectedHours > params.monthlyRuntimeHoursLimit) {
    return { ok: false, reason: `Monthly runtime limit would be exceeded (${projectedHours.toFixed(1)}h / ${params.monthlyRuntimeHoursLimit}h).` };
  }
  return { ok: true };
}

