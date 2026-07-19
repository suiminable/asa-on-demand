export interface Heartbeat {
  playerCount: number;
  updatedAt: string;
  runId?: string;
  mapId?: string;
}

export interface ReadyMarker {
  runId: string;
  mapId: string;
  readyAt: string;
}

export function validHeartbeat(
  value: unknown,
  params: { now: Date; startedAt: string | null | undefined; freshnessSeconds: number; runId?: string; mapId?: string },
): Heartbeat | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { playerCount?: unknown; updatedAt?: unknown; runId?: unknown; mapId?: unknown };
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
  if (params.runId && candidate.runId !== params.runId) return undefined;
  if (params.mapId && candidate.mapId !== params.mapId) return undefined;

  return {
    playerCount: candidate.playerCount as number,
    updatedAt: candidate.updatedAt,
    ...(typeof candidate.runId === "string" ? { runId: candidate.runId } : {}),
    ...(typeof candidate.mapId === "string" ? { mapId: candidate.mapId } : {}),
  };
}

export function parseHeartbeatJson(
  body: string | undefined,
  params: { now: Date; startedAt: string | null | undefined; freshnessSeconds: number; runId?: string; mapId?: string },
): Heartbeat | undefined {
  if (!body) return undefined;
  try {
    return validHeartbeat(JSON.parse(body), params);
  } catch {
    return undefined;
  }
}

export function validReadyMarker(
  value: unknown,
  params: { now: Date; startedAt: string | null | undefined; runId: string; mapId: string },
): ReadyMarker | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { runId?: unknown; mapId?: unknown; readyAt?: unknown };
  if (candidate.runId !== params.runId || candidate.mapId !== params.mapId || typeof candidate.readyAt !== "string") return undefined;
  const readyAtMs = Date.parse(candidate.readyAt);
  const startedAtMs = params.startedAt ? Date.parse(params.startedAt) : Number.NaN;
  if (
    !Number.isFinite(readyAtMs) ||
    !Number.isFinite(startedAtMs) ||
    readyAtMs < startedAtMs ||
    readyAtMs > params.now.getTime() + 60_000
  ) {
    return undefined;
  }
  return { runId: params.runId, mapId: params.mapId, readyAt: candidate.readyAt };
}

export function parseReadyJson(
  body: string | undefined,
  params: { now: Date; startedAt: string | null | undefined; runId: string; mapId: string },
): ReadyMarker | undefined {
  if (!body) return undefined;
  try {
    return validReadyMarker(JSON.parse(body), params);
  } catch {
    return undefined;
  }
}
