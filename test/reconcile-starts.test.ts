import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ecsSend: vi.fn(),
  schedulerSend: vi.fn(),
  getStaleOperations: vi.fn(),
  getMap: vi.fn(),
  attachStartedTask: vi.fn(),
  rollbackMapStart: vi.fn(),
  markOperationScheduled: vi.fn(),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  DescribeTasksCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  ListTasksCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  ECSClient: class {
    send = mocks.ecsSend;
  },
}));

vi.mock("@aws-sdk/client-scheduler", () => ({
  CreateScheduleCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
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
      STOP_SCHEDULER_ROLE_ARN: "scheduler-role",
      STOP_SERVER_FUNCTION_ARN: "stop-function",
    })[name] ?? name,
}));

vi.mock("../src/shared/state.js", () => ({
  StateStore: class {
    getStaleOperations = mocks.getStaleOperations;
    getMap = mocks.getMap;
    attachStartedTask = mocks.attachStartedTask;
    rollbackMapStart = mocks.rollbackMapStart;
    markOperationScheduled = mocks.markOperationScheduled;
  },
}));

import { handler } from "../src/lambdas/reconcile-starts/index.js";

const operation = {
  pk: "OPERATION#run-island-12345678",
  runId: "run-island-12345678",
  mapId: "the-island",
  phase: "CLAIMED",
  reservations: [{ budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600 }],
  updatedAt: "2026-07-19T00:00:00.000Z",
  ttl: 1,
} as const;

beforeEach(() => {
  mocks.ecsSend.mockReset();
  mocks.schedulerSend.mockReset().mockResolvedValue({});
  mocks.getStaleOperations.mockReset().mockResolvedValue([operation]);
  mocks.getMap.mockReset().mockResolvedValue({
    pk: "MAP#the-island",
    mapId: "the-island",
    runId: operation.runId,
    status: "STARTING",
    reservations: operation.reservations,
  });
  mocks.attachStartedTask.mockReset().mockResolvedValue(true);
  mocks.rollbackMapStart.mockReset().mockResolvedValue(true);
  mocks.markOperationScheduled.mockReset().mockResolvedValue(true);
});

describe("stale start reconciliation", () => {
  it("rolls back the exact reservation when ECS has no matching task", async () => {
    mocks.ecsSend.mockResolvedValue({ taskArns: [] });

    await handler();

    expect(mocks.rollbackMapStart).toHaveBeenCalledWith(
      "the-island",
      "run-island-12345678",
      operation.reservations,
      "STALE_START_RECONCILED",
    );
    expect(mocks.attachStartedTask).not.toHaveBeenCalled();
  });

  it("releases a stale RUNNING claim when its task is no longer active", async () => {
    mocks.getMap.mockResolvedValue({
      pk: "MAP#the-island",
      mapId: "the-island",
      runId: operation.runId,
      status: "RUNNING",
      reservations: operation.reservations,
    });
    mocks.ecsSend.mockResolvedValue({ taskArns: [] });

    await handler();

    expect(mocks.rollbackMapStart).toHaveBeenCalledWith(
      "the-island",
      "run-island-12345678",
      operation.reservations,
      "STALE_START_RECONCILED",
    );
  });

  it("describes the attached task before relying on eventually consistent task listings", async () => {
    mocks.getMap.mockResolvedValue({
      pk: "MAP#the-island",
      mapId: "the-island",
      runId: operation.runId,
      status: "RUNNING",
      taskArn: "task-known",
      reservations: operation.reservations,
    });
    mocks.ecsSend.mockResolvedValue({
      tasks: [{ taskArn: "task-known", group: "asa-map:the-island:run-island-12345678", lastStatus: "RUNNING" }],
    });

    await handler();

    expect(mocks.ecsSend).toHaveBeenCalledTimes(1);
    expect(mocks.attachStartedTask).toHaveBeenCalledWith("the-island", "run-island-12345678", "task-known");
    expect(mocks.rollbackMapStart).not.toHaveBeenCalled();
  });

  it("keeps a post-launch failure reserved while its task is still stopping", async () => {
    mocks.getMap.mockResolvedValue({
      pk: "MAP#the-island",
      mapId: "the-island",
      runId: operation.runId,
      status: "STOPPING",
      taskArn: "task-known",
      reservations: operation.reservations,
    });
    mocks.ecsSend.mockResolvedValue({
      tasks: [{ taskArn: "task-known", group: "asa-map:the-island:run-island-12345678", lastStatus: "STOPPING" }],
    });

    await handler();

    expect(mocks.rollbackMapStart).not.toHaveBeenCalled();
    expect(mocks.attachStartedTask).not.toHaveBeenCalled();
  });

  it("releases a post-launch failure if its STOPPED event never settled", async () => {
    mocks.getMap.mockResolvedValue({
      pk: "MAP#the-island",
      mapId: "the-island",
      runId: operation.runId,
      status: "STOPPING",
      taskArn: "task-known",
      reservations: operation.reservations,
    });
    mocks.ecsSend.mockResolvedValue({
      tasks: [{ taskArn: "task-known", group: "asa-map:the-island:run-island-12345678", lastStatus: "STOPPED" }],
    });

    await handler();

    expect(mocks.rollbackMapStart).toHaveBeenCalledWith(
      "the-island",
      "run-island-12345678",
      operation.reservations,
      "STALE_STOPPING_START_RECONCILED",
    );
  });

  it("reattaches a matching ECS task and recreates its map-scoped schedule", async () => {
    mocks.ecsSend
      .mockResolvedValueOnce({ taskArns: ["task-1"] })
      .mockResolvedValueOnce({ tasks: [{ group: "asa-map:the-island:run-island-12345678" }] });

    await handler();

    expect(mocks.attachStartedTask).toHaveBeenCalledWith("the-island", "run-island-12345678", "task-1");
    expect(mocks.schedulerSend).toHaveBeenCalledTimes(2);
    expect(mocks.schedulerSend.mock.calls[1][0].input).toMatchObject({
      Name: "asa-default-the-island-auto-stop",
      Target: {
        Arn: "stop-function",
        RoleArn: "scheduler-role",
        Input: JSON.stringify({
          source: "IDLE_CHECK",
          mapId: "the-island",
          runId: "run-island-12345678",
          expectedTaskArn: "task-1",
        }),
      },
    });
    expect(mocks.markOperationScheduled).toHaveBeenCalledWith("run-island-12345678", "the-island", "task-1");
    expect(mocks.rollbackMapStart).not.toHaveBeenCalled();
  });
});
