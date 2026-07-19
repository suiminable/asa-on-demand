import { describe, expect, it } from "vitest";
import { evaluateIdleCheck } from "../src/shared/idle-check.js";
import type { BudgetState, MapServerState } from "../src/shared/types.js";

const now = new Date("2026-07-17T00:46:00.000Z");

function state(values: Partial<MapServerState> = {}): MapServerState {
  return {
    pk: "MAP#the-island",
    mapId: "the-island",
    arkMapName: "TheIsland_WP",
    status: "RUNNING",
    runId: "run-island-12345678",
    taskArn: "task-1",
    clusterArn: "cluster",
    startedAt: "2026-07-17T00:00:00.000Z",
    taskStartedAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-17T08:00:00.000Z",
    publicIp: "203.0.113.10",
    connectCommand: "open 203.0.113.10:7777",
    sessionName: "private-asa",
    eventModId: null,
    maxPlayers: 4,
    idleTimeoutMinutes: 45,
    idleSince: null,
    lastHeartbeatAt: null,
    startedByDiscordUserId: "user-1",
    startedFromChannelId: "channel-1",
    readyAt: null,
    lastBackupAt: null,
    lastStopReason: null,
    lastEcsEventVersion: 1,
    reservations: [{ budgetPk: "BUDGET#2026-07", runtimeSeconds: 8 * 3600 }],
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...values,
  };
}

function budget(runtimeSeconds: number): BudgetState {
  return {
    pk: "BUDGET#2026-07",
    runtimeSeconds,
    estimatedCostUsd: 0,
    estimatedCostJpy: 0,
    startCount: 1,
    updatedAt: "",
  };
}

function evaluate(values: { state?: MapServerState; heartbeat?: unknown; budget?: BudgetState; at?: Date }) {
  const heartbeat =
    values.heartbeat && typeof values.heartbeat === "object"
      ? { mapId: values.state?.mapId ?? "the-island", ...values.heartbeat }
      : values.heartbeat;
  return evaluateIdleCheck({
    state: values.state,
    heartbeat,
    budget: values.budget,
    now: values.at ?? now,
    monthlyRuntimeHoursLimit: 80,
    heartbeatFreshnessSeconds: 180,
  });
}

describe("idle check evaluation", () => {
  it("stops after distinct zero-player samples span the session timeout", () => {
    const decision = evaluate({
      state: state({ idleSince: "2026-07-17T00:00:00.000Z", lastHeartbeatAt: "2026-07-17T00:44:00.000Z" }),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision).toMatchObject({ action: "STOP", reason: "IDLE_TIMEOUT", rule: "RCON_ZERO", idleMinutes: 45 });
  });

  it("uses the configured session timeout, including the minimum", () => {
    const decision = evaluate({
      state: state({
        idleTimeoutMinutes: 1,
        idleSince: "2026-07-17T00:44:00.000Z",
        lastHeartbeatAt: "2026-07-17T00:44:00.000Z",
      }),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision.reason).toBe("IDLE_TIMEOUT");
  });

  it("uses the configured maximum session timeout", () => {
    const decision = evaluate({
      state: state({
        startedAt: "2026-07-16T00:00:00.000Z",
        taskStartedAt: "2026-07-16T00:00:00.000Z",
        idleTimeoutMinutes: 1440,
        idleSince: "2026-07-16T00:45:00.000Z",
        lastHeartbeatAt: "2026-07-17T00:44:00.000Z",
      }),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision).toMatchObject({ reason: "IDLE_TIMEOUT", idleMinutes: 1440 });
  });

  it("does not advance time when the same heartbeat is read again", () => {
    const decision = evaluate({
      state: state({ idleSince: "2026-07-17T00:00:00.000Z", lastHeartbeatAt: "2026-07-17T00:45:00.000Z" }),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision).toMatchObject({ action: "NONE", rule: "SAMPLE_REUSED" });
    expect(decision.stateUpdate).toBeUndefined();
  });

  it("records the first distinct zero-player sample without stopping", () => {
    const decision = evaluate({
      state: state(),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision).toMatchObject({ action: "NONE", rule: "RCON_ZERO", idleMinutes: 0 });
    expect(decision.stateUpdate).toEqual({
      idleSince: "2026-07-17T00:45:00.000Z",
      lastHeartbeatAt: "2026-07-17T00:45:00.000Z",
    });
  });

  it("clears the idle interval when players are present", () => {
    const decision = evaluate({
      state: state({ idleSince: "2026-07-17T00:00:00.000Z", lastHeartbeatAt: "2026-07-17T00:44:00.000Z" }),
      heartbeat: { playerCount: 2, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision.rule).toBe("PLAYERS_PRESENT");
    expect(decision.stateUpdate).toEqual({ idleSince: null, lastHeartbeatAt: "2026-07-17T00:45:00.000Z" });
  });

  it.each([
    undefined,
    {},
    { playerCount: -1, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    { playerCount: 0.5, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    { playerCount: 0, updatedAt: "2026-07-17T00:46:01.000Z", runId: "run-island-12345678" },
    { playerCount: 0, updatedAt: "2026-07-17T00:42:59.000Z", runId: "run-island-12345678" },
    { playerCount: 0, updatedAt: "2026-07-16T23:59:59.000Z", runId: "run-island-12345678" },
    { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "old-run-12345678" },
    {
      playerCount: 0,
      updatedAt: "2026-07-17T00:45:00.000Z",
      runId: "run-island-12345678",
      mapId: "scorched-earth",
    },
  ])("does not stop for a missing or invalid heartbeat (%j)", (heartbeat) => {
    const decision = evaluate({
      state: state({ idleSince: "2026-07-17T00:00:00.000Z", lastHeartbeatAt: "2026-07-17T00:44:00.000Z" }),
      heartbeat,
    });

    expect(decision).toMatchObject({ action: "NONE", rule: "HEARTBEAT_INVALID" });
    expect(decision.stateUpdate).toEqual({ idleSince: null, lastHeartbeatAt: null });
  });

  it("resets continuity when observed heartbeat samples are too far apart", () => {
    const decision = evaluate({
      state: state({ idleSince: "2026-07-17T00:00:00.000Z", lastHeartbeatAt: "2026-07-17T00:41:00.000Z" }),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:45:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision.stateUpdate).toEqual({
      idleSince: "2026-07-17T00:45:00.000Z",
      lastHeartbeatAt: "2026-07-17T00:45:00.000Z",
    });
    expect(decision.action).toBe("NONE");
  });

  it("rejects an out-of-order heartbeat and resets continuity", () => {
    const decision = evaluate({
      state: state({ idleSince: "2026-07-17T00:00:00.000Z", lastHeartbeatAt: "2026-07-17T00:45:00.000Z" }),
      heartbeat: { playerCount: 0, updatedAt: "2026-07-17T00:44:00.000Z", runId: "run-island-12345678" },
    });

    expect(decision.rule).toBe("SAMPLE_OUT_OF_ORDER");
    expect(decision.stateUpdate).toEqual({ idleSince: null, lastHeartbeatAt: null });
  });

  it("stops at the monthly limit regardless of heartbeat validity", () => {
    const decision = evaluate({
      state: state({ taskStartedAt: "2026-07-17T00:36:00.000Z" }),
      heartbeat: undefined,
      budget: budget(79 * 3600 + 50 * 60),
    });

    expect(decision).toMatchObject({ action: "STOP", reason: "BUDGET_EXCEEDED", currentMonthRuntimeSeconds: 80 * 3600 });
  });

  it("does not perform idle evaluation while starting", () => {
    const decision = evaluate({
      state: state({ status: "STARTING" }),
      heartbeat: { playerCount: 0, updatedAt: now.toISOString(), runId: "run-island-12345678" },
    });
    expect(decision).toMatchObject({ action: "NONE", rule: "STARTING" });
  });

  it("deletes the schedule when the server is not running", () => {
    const decision = evaluate({ state: state({ status: "STOPPED", taskArn: null }) });
    expect(decision).toMatchObject({ action: "DELETE_SCHEDULE", rule: "NOT_RUNNING" });
  });

  it("rejects an active state without a run generation", () => {
    const decision = evaluate({ state: state({ runId: null }) });
    expect(decision).toMatchObject({ action: "DELETE_SCHEDULE", rule: "NOT_RUNNING" });
  });
});
