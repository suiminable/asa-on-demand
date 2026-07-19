import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ecsSend: vi.fn(),
  s3Send: vi.fn(),
  schedulerSend: vi.fn(),
  getMap: vi.fn(),
  getBudget: vi.fn(),
  updateRunningIdleState: vi.fn(),
  markMapStopping: vi.fn(),
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
    ({ TABLE_NAME: "table", CLUSTER_ARN: "cluster", NOTIFICATION_WEBHOOK_SECRET_NAME: "webhook", S3_BUCKET: "bucket" })[name] ?? name,
  intEnv: (_name: string, fallback: number) => fallback,
  getSecret: vi.fn().mockResolvedValue("https://example.invalid/webhook"),
}));
vi.mock("../src/shared/discord.js", () => ({ postWebhook: mocks.postWebhook }));
vi.mock("../src/shared/state.js", () => ({
  StateStore: class {
    getMap = mocks.getMap;
    getBudget = mocks.getBudget;
    updateRunningIdleState = mocks.updateRunningIdleState;
    markMapStopping = mocks.markMapStopping;
  },
}));

import { handler } from "../src/lambdas/stop-server/index.js";

function runningState() {
  return {
    pk: "MAP#the-island",
    mapId: "the-island",
    arkMapName: "TheIsland_WP",
    status: "RUNNING",
    runId: "run-island-12345678",
    taskArn: "task-1",
    clusterArn: "cluster",
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    taskStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    sessionName: "private-asa-island",
    maxPlayers: 4,
    idleTimeoutMinutes: 30,
    idleSince: null,
    lastHeartbeatAt: null,
    reservations: [],
    updatedAt: new Date().toISOString(),
  };
}

function input(state = runningState()) {
  return { source: "IDLE_CHECK" as const, mapId: state.mapId, runId: state.runId, expectedTaskArn: state.taskArn };
}

beforeEach(() => {
  mocks.ecsSend.mockReset().mockResolvedValue({});
  mocks.s3Send.mockReset();
  mocks.schedulerSend.mockReset().mockResolvedValue({});
  mocks.getMap.mockReset();
  mocks.getBudget.mockReset().mockResolvedValue(undefined);
  mocks.updateRunningIdleState.mockReset().mockResolvedValue(true);
  mocks.markMapStopping.mockReset().mockResolvedValue(true);
  mocks.postWebhook.mockReset().mockResolvedValue(undefined);
});

describe("map-scoped stop checks", () => {
  it("persists a fresh heartbeat only for the current run", async () => {
    const state = runningState();
    const updatedAt = new Date(Date.now() - 60_000).toISOString();
    mocks.getMap.mockResolvedValue(state);
    mocks.s3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify({ playerCount: 0, updatedAt, runId: state.runId, mapId: state.mapId }) },
    });
    expect(await handler(input(state))).toEqual({ stopped: false, reason: "RCON_ZERO" });
    expect(mocks.updateRunningIdleState).toHaveBeenCalledWith(state.mapId, state.runId, state.taskArn, {
      idleSince: updatedAt,
      lastHeartbeatAt: updatedAt,
    });
  });

  it("ignores a stale schedule without deleting the current map schedule", async () => {
    const state = runningState();
    mocks.getMap.mockResolvedValue(state);
    expect(await handler({ ...input(state), runId: "old-run-12345678" })).toEqual({ stopped: false, reason: "stale request" });
    expect(mocks.ecsSend).not.toHaveBeenCalled();
    expect(mocks.schedulerSend).not.toHaveBeenCalled();
  });

  it("stops exactly the matching task when its reserved session expires", async () => {
    const state = runningState();
    state.expiresAt = new Date(Date.now() - 1000).toISOString();
    mocks.getMap.mockResolvedValue(state);
    expect(await handler(input(state))).toEqual({ stopped: true, reason: "SESSION_EXPIRED" });
    expect(mocks.ecsSend).toHaveBeenCalledOnce();
    expect(mocks.markMapStopping).toHaveBeenCalledWith(state.mapId, state.runId, state.taskArn, "SESSION_EXPIRED");
    expect(mocks.schedulerSend).toHaveBeenCalledOnce();
  });
});
