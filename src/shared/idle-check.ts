import { activeRuntimeSecondsThisMonth } from "./budget.js";
import { validHeartbeat } from "./heartbeat.js";
import type { BudgetState, ServerState } from "./types.js";

export type IdleCheckRule =
  | "NOT_RUNNING"
  | "BUDGET_EXCEEDED"
  | "STARTING"
  | "HEARTBEAT_INVALID"
  | "SAMPLE_REUSED"
  | "SAMPLE_OUT_OF_ORDER"
  | "PLAYERS_PRESENT"
  | "RCON_ZERO";

export interface IdleStateUpdate {
  idleSince: string | null;
  lastHeartbeatAt: string | null;
}

export interface IdleCheckDecision {
  action: "STOP" | "DELETE_SCHEDULE" | "NONE";
  rule: IdleCheckRule;
  reason?: "IDLE_TIMEOUT" | "BUDGET_EXCEEDED";
  stateUpdate?: IdleStateUpdate;
  heartbeatAgeSeconds?: number;
  playerCount?: number;
  idleMinutes?: number;
  currentMonthRuntimeSeconds: number;
}

function changedIdleState(state: ServerState, idleSince: string | null, lastHeartbeatAt: string | null): IdleStateUpdate | undefined {
  if ((state.idleSince ?? null) === idleSince && (state.lastHeartbeatAt ?? null) === lastHeartbeatAt) return undefined;
  return { idleSince, lastHeartbeatAt };
}

export function evaluateIdleCheck(params: {
  state: ServerState | undefined;
  heartbeat: unknown;
  budget: BudgetState | undefined;
  now: Date;
  monthlyRuntimeHoursLimit: number;
  heartbeatFreshnessSeconds: number;
}): IdleCheckDecision {
  const { state, now } = params;
  if (!state?.taskArn || (state.status !== "RUNNING" && state.status !== "STARTING")) {
    return { action: "DELETE_SCHEDULE", rule: "NOT_RUNNING", currentMonthRuntimeSeconds: params.budget?.runtimeSeconds ?? 0 };
  }

  const activeRuntime = activeRuntimeSecondsThisMonth(state.taskStartedAt ?? state.startedAt, now);
  const currentMonthRuntimeSeconds = (params.budget?.runtimeSeconds ?? 0) + activeRuntime;
  if (currentMonthRuntimeSeconds >= params.monthlyRuntimeHoursLimit * 3600) {
    return {
      action: "STOP",
      rule: "BUDGET_EXCEEDED",
      reason: "BUDGET_EXCEEDED",
      currentMonthRuntimeSeconds,
    };
  }

  if (state.status !== "RUNNING") {
    return { action: "NONE", rule: "STARTING", currentMonthRuntimeSeconds };
  }

  const heartbeat = validHeartbeat(params.heartbeat, {
    now,
    startedAt: state.startedAt,
    freshnessSeconds: params.heartbeatFreshnessSeconds,
  });
  if (!heartbeat) {
    return {
      action: "NONE",
      rule: "HEARTBEAT_INVALID",
      stateUpdate: changedIdleState(state, null, null),
      currentMonthRuntimeSeconds,
    };
  }

  const heartbeatAtMs = Date.parse(heartbeat.updatedAt);
  const heartbeatAgeSeconds = (now.getTime() - heartbeatAtMs) / 1000;
  if (heartbeat.updatedAt === state.lastHeartbeatAt) {
    return {
      action: "NONE",
      rule: "SAMPLE_REUSED",
      heartbeatAgeSeconds,
      playerCount: heartbeat.playerCount,
      currentMonthRuntimeSeconds,
    };
  }

  const lastHeartbeatAtMs = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : Number.NaN;
  if (Number.isFinite(lastHeartbeatAtMs) && heartbeatAtMs < lastHeartbeatAtMs) {
    return {
      action: "NONE",
      rule: "SAMPLE_OUT_OF_ORDER",
      stateUpdate: changedIdleState(state, null, null),
      heartbeatAgeSeconds,
      playerCount: heartbeat.playerCount,
      currentMonthRuntimeSeconds,
    };
  }

  const sequenceBroken = Number.isFinite(lastHeartbeatAtMs) && heartbeatAtMs - lastHeartbeatAtMs > params.heartbeatFreshnessSeconds * 1000;
  if (heartbeat.playerCount >= 1) {
    return {
      action: "NONE",
      rule: "PLAYERS_PRESENT",
      stateUpdate: changedIdleState(state, null, heartbeat.updatedAt),
      heartbeatAgeSeconds,
      playerCount: heartbeat.playerCount,
      currentMonthRuntimeSeconds,
    };
  }

  const idleSince = sequenceBroken || !state.idleSince ? heartbeat.updatedAt : state.idleSince;
  const idleSinceMs = Date.parse(idleSince);
  const idleMinutes = Math.max(0, (heartbeatAtMs - idleSinceMs) / 60_000);
  const stateUpdate = changedIdleState(state, idleSince, heartbeat.updatedAt);
  if (idleMinutes >= state.idleTimeoutMinutes) {
    return {
      action: "STOP",
      rule: "RCON_ZERO",
      reason: "IDLE_TIMEOUT",
      heartbeatAgeSeconds,
      playerCount: heartbeat.playerCount,
      idleMinutes,
      currentMonthRuntimeSeconds,
    };
  }

  return {
    action: "NONE",
    rule: "RCON_ZERO",
    stateUpdate,
    heartbeatAgeSeconds,
    playerCount: heartbeat.playerCount,
    idleMinutes,
    currentMonthRuntimeSeconds,
  };
}
