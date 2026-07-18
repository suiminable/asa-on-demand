import type { BudgetState } from "./types.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstYearMonth(now: Date): { year: number; month: number } {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

export function monthKey(now = new Date()): string {
  const { year, month } = jstYearMonth(now);
  return `BUDGET#${year}-${String(month).padStart(2, "0")}`;
}

export function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

export function startOfJstMonth(now: Date): Date {
  const { year, month } = jstYearMonth(now);
  return new Date(Date.UTC(year, month - 1, 1) - JST_OFFSET_MS);
}

function startOfNextJstMonth(now: Date): Date {
  const { year, month } = jstYearMonth(now);
  return new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS);
}

export function runtimeSecondsBetween(startedAt: string | null | undefined, stoppedAt: Date): number {
  if (!startedAt) return 0;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((stoppedAt.getTime() - start) / 1000));
}

export function activeRuntimeSecondsThisMonth(startedAt: string | null | undefined, now: Date): number {
  if (!startedAt) return 0;
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) return 0;
  const start = Math.max(parsed, startOfJstMonth(now).getTime());
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
}

export function currentMonthRuntimeSeconds(params: { budget: BudgetState | undefined; taskStartedAt?: string | null; now?: Date }): number {
  return (params.budget?.runtimeSeconds ?? 0) + activeRuntimeSecondsThisMonth(params.taskStartedAt, params.now ?? new Date());
}

export interface RuntimeSlice {
  budgetPk: string;
  runtimeSeconds: number;
}

export function splitRuntimeByJstMonth(startedAt: string | null | undefined, stoppedAt: Date): RuntimeSlice[] {
  if (!startedAt) return [];
  const startedAtMs = Date.parse(startedAt);
  const stoppedAtMs = stoppedAt.getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(stoppedAtMs) || stoppedAtMs <= startedAtMs) return [];

  const rawSlices: Array<{ budgetPk: string; milliseconds: number }> = [];
  let cursor = new Date(startedAtMs);
  while (cursor.getTime() < stoppedAtMs) {
    const nextMonth = startOfNextJstMonth(cursor);
    const end = Math.min(stoppedAtMs, nextMonth.getTime());
    rawSlices.push({ budgetPk: monthKey(cursor), milliseconds: end - cursor.getTime() });
    cursor = new Date(end);
  }

  const totalSeconds = Math.round((stoppedAtMs - startedAtMs) / 1000);
  let allocatedSeconds = 0;
  return rawSlices.map((slice, index) => {
    const runtimeSeconds = index === rawSlices.length - 1 ? totalSeconds - allocatedSeconds : Math.floor(slice.milliseconds / 1000);
    allocatedSeconds += runtimeSeconds;
    return { budgetPk: slice.budgetPk, runtimeSeconds };
  });
}

export function canStart(params: {
  budget: BudgetState | undefined;
  monthlyRuntimeHoursLimit: number;
}): { ok: true } | { ok: false; reason: string } {
  const runtimeSeconds = params.budget?.runtimeSeconds ?? 0;
  const runtimeHours = runtimeSeconds / 3600;
  if (runtimeHours >= params.monthlyRuntimeHoursLimit) {
    return {
      ok: false,
      reason: `Monthly runtime limit has been reached (${runtimeHours.toFixed(1)}h / ${params.monthlyRuntimeHoursLimit}h).`,
    };
  }
  return { ok: true };
}
