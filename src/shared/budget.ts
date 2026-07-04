import type { BudgetState } from "./types.js";

export function monthKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Failed to format the JST budget month.");
  return `BUDGET#${year}-${month}`;
}

export function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

export function canStart(params: {
  budget: BudgetState | undefined;
  requestedHours: number;
  monthlyRuntimeHoursLimit: number;
}): { ok: true } | { ok: false; reason: string } {
  const runtimeSeconds = params.budget?.runtimeSeconds ?? 0;
  const projectedHours = runtimeSeconds / 3600 + params.requestedHours;
  if (projectedHours > params.monthlyRuntimeHoursLimit) {
    return {
      ok: false,
      reason: `Monthly runtime limit would be exceeded (${projectedHours.toFixed(1)}h / ${params.monthlyRuntimeHoursLimit}h).`,
    };
  }
  return { ok: true };
}
