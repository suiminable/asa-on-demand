import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ecsSend: vi.fn(),
  s3Send: vi.fn(),
  schedulerSend: vi.fn(),
  getServer: vi.fn(),
  getBudget: vi.fn(),
  updateRunningIdleState: vi.fn(),
  updateServerStatus: vi.fn(),
  postWebhook: vi.fn(),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  StopTaskCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  ECSClient: class {
    send = mocks.ecsSend;
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  S3Client: class {
    send = mocks.s3Send;
  },
}));

vi.mock("@aws-sdk/client-scheduler", () => ({
  DeleteScheduleCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  SchedulerClient: class {
    send = mocks.schedulerSend;
  },
}));

vi.mock("../src/shared/config.js", () => ({
  requireEnv: (name: string) =>
    ({
      TABLE_NAME: "table",
      CLUSTER_ARN: "cluster",
      NOTIFICATION_WEBHOOK_SECRET_NAME: "webhook-secret",
      STOP_SCHEDULE_NAME: "stop-schedule",
      S3_BUCKET: "bucket",
    })[name] ?? name,
  intEnv: (_name: string, fallback: number) => fallback,
  getSecret: vi.fn().mockResolvedValue("https://example.invalid/webhook"),
}));

vi.mock("../src/shared/discord.js", () => ({ postWebhook: mocks.postWebhook }));

vi.mock("../src/shared/state.js", () => ({
  StateStore: class {
    getServer = mocks.getServer;
    getBudget = mocks.getBudget;
    updateRunningIdleState = mocks.updateRunningIdleState;
    updateServerStatus = mocks.updateServerStatus;
  },
}));

import { handler } from "../src/lambdas/stop-server/index.js";

function runningState() {
  return {
    pk: "SERVER",
    status: "RUNNING",
    taskArn: "task-1",
    clusterArn: "cluster",
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    taskStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    sessionName: "private-asa",
    mapName: "TheIsland_WP",
    maxPlayers: 4,
    idleTimeoutMinutes: 30,
    idleSince: null,
    lastHeartbeatAt: null,
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  mocks.ecsSend.mockReset().mockResolvedValue({});
  mocks.s3Send.mockReset();
  mocks.schedulerSend.mockReset().mockResolvedValue({});
  mocks.getServer.mockReset();
  mocks.getBudget.mockReset().mockResolvedValue(undefined);
  mocks.updateRunningIdleState.mockReset().mockResolvedValue(true);
  mocks.updateServerStatus.mockReset().mockResolvedValue(undefined);
  mocks.postWebhook.mockReset().mockResolvedValue(undefined);
});

describe("stop-server idle checks", () => {
  it("persists a distinct zero-player sample without stopping", async () => {
    const state = runningState();
    const updatedAt = new Date(Date.now() - 60_000).toISOString();
    mocks.getServer.mockResolvedValue(state);
    mocks.s3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify({ playerCount: 0, updatedAt }) },
    });

    const result = await handler({ source: "IDLE_CHECK" });

    expect(result).toEqual({ stopped: false, reason: "RCON_ZERO" });
    expect(mocks.updateRunningIdleState).toHaveBeenCalledWith("task-1", { idleSince: updatedAt, lastHeartbeatAt: updatedAt });
    expect(mocks.ecsSend).not.toHaveBeenCalled();
  });

  it("stops and deletes the schedule when the monthly limit is reached", async () => {
    const state = runningState();
    state.taskStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    mocks.getServer.mockResolvedValue(state);
    mocks.getBudget.mockResolvedValue({
      pk: "BUDGET#2026-07",
      runtimeSeconds: 79 * 3600 + 50 * 60,
      estimatedCostUsd: 0,
      estimatedCostJpy: 0,
      startCount: 1,
      updatedAt: "",
    });

    const result = await handler({ source: "IDLE_CHECK" });

    expect(result).toEqual({ stopped: true, reason: "BUDGET_EXCEEDED" });
    expect(mocks.ecsSend).toHaveBeenCalledOnce();
    expect(mocks.updateServerStatus).toHaveBeenCalledWith("STOPPING", { lastStopReason: "BUDGET_EXCEEDED" });
    expect(mocks.schedulerSend).toHaveBeenCalledOnce();
    expect(mocks.postWebhook).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("Reason: BUDGET_EXCEEDED"));
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it("deletes an orphaned recurring schedule", async () => {
    mocks.getServer.mockResolvedValue(undefined);

    expect(await handler({ source: "IDLE_CHECK" })).toEqual({ stopped: false, reason: "not running" });
    expect(mocks.schedulerSend).toHaveBeenCalledOnce();
    expect(mocks.ecsSend).not.toHaveBeenCalled();
  });
});
