import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ecsSend: vi.fn(),
  s3Send: vi.fn(),
  schedulerSend: vi.fn(),
  getMap: vi.fn(),
  getMaps: vi.fn(),
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
    getMaps = mocks.getMaps;
    getBudget = mocks.getBudget;
    updateRunningIdleState = mocks.updateRunningIdleState;
    markMapStopping = mocks.markMapStopping;
  },
}));

import { handler } from "../src/lambdas/stop-server/index.js";

function runningState(values: Record<string, unknown> = {}) {
  const mapId = String(values.mapId ?? "the-island");
  return {
    pk: `MAP#${mapId}`,
    mapId,
    arkMapName: mapId === "the-island" ? "TheIsland_WP" : "ScorchedEarth_WP",
    status: "RUNNING",
    runId: `run-${mapId}-12345678`,
    taskArn: `task-${mapId}`,
    clusterArn: "cluster",
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    taskStartedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    sessionName: `private-asa-${mapId}`,
    maxPlayers: 4,
    idleTimeoutMinutes: 30,
    idleSince: null,
    lastHeartbeatAt: null,
    updatedAt: new Date().toISOString(),
    ...values,
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
  mocks.getMaps.mockReset().mockResolvedValue([]);
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

  it("applies each Map session's idle timeout without sharing idle progress", async () => {
    const idleSince = new Date(Date.now() - 2 * 60_000).toISOString();
    const lastHeartbeatAt = idleSince;
    const heartbeatAt = new Date(Date.now() - 60_000).toISOString();
    const island = runningState({ idleTimeoutMinutes: 1, idleSince, lastHeartbeatAt });
    const scorched = runningState({ mapId: "scorched-earth", idleTimeoutMinutes: 30, idleSince, lastHeartbeatAt });
    mocks.getMaps.mockResolvedValue([island, scorched]);
    mocks.s3Send.mockImplementation((command) => {
      const mapId = command.input.Key.includes("scorched-earth") ? "scorched-earth" : "the-island";
      const current = mapId === "the-island" ? island : scorched;
      return Promise.resolve({
        Body: { transformToString: async () => JSON.stringify({ playerCount: 0, updatedAt: heartbeatAt, runId: current.runId, mapId }) },
      });
    });

    mocks.getMap.mockResolvedValueOnce(island).mockResolvedValueOnce(scorched);
    expect(await handler(input(island))).toEqual({ stopped: true, reason: "IDLE_TIMEOUT" });
    expect(await handler(input(scorched))).toEqual({ stopped: false, reason: "RCON_ZERO" });
    expect(mocks.markMapStopping).toHaveBeenCalledOnce();
    expect(mocks.markMapStopping).toHaveBeenCalledWith(island.mapId, island.runId, island.taskArn, "IDLE_TIMEOUT");
  });
});
