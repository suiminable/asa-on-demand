export interface Heartbeat {
  playerCount: number;
  updatedAt: string;
}

export function validHeartbeat(
  value: unknown,
  params: { now: Date; startedAt: string | null | undefined; freshnessSeconds: number },
): Heartbeat | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { playerCount?: unknown; updatedAt?: unknown };
  if (!Number.isInteger(candidate.playerCount) || (candidate.playerCount as number) < 0 || typeof candidate.updatedAt !== "string") {
    return undefined;
  }

  const updatedAtMs = Date.parse(candidate.updatedAt);
  const startedAtMs = params.startedAt ? Date.parse(params.startedAt) : Number.NaN;
  const ageMs = params.now.getTime() - updatedAtMs;
  if (
    !Number.isFinite(updatedAtMs) ||
    !Number.isFinite(startedAtMs) ||
    updatedAtMs < startedAtMs ||
    ageMs < 0 ||
    ageMs > params.freshnessSeconds * 1000
  ) {
    return undefined;
  }

  return { playerCount: candidate.playerCount as number, updatedAt: candidate.updatedAt };
}

export function parseHeartbeatJson(
  body: string | undefined,
  params: { now: Date; startedAt: string | null | undefined; freshnessSeconds: number },
): Heartbeat | undefined {
  if (!body) return undefined;
  try {
    return validHeartbeat(JSON.parse(body), params);
  } catch {
    return undefined;
  }
}
