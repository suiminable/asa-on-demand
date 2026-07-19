import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.send }) },
  BatchGetCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  GetCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  TransactWriteCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  UpdateCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import { StateStore } from "../src/shared/state.js";

function startParams(mapId: "the-island" | "scorched-earth", runId = `run-${mapId}-12345678`) {
  const now = "2026-07-19T00:00:00.000Z";
  const arkMapName = mapId === "the-island" ? "TheIsland_WP" : "ScorchedEarth_WP";
  const reservations = [{ budgetPk: "BUDGET#2026-07", runtimeSeconds: 28_800 }];
  return {
    state: {
      pk: `MAP#${mapId}` as const,
      mapId,
      arkMapName,
      status: "STARTING" as const,
      runId,
      taskArn: null,
      clusterArn: "cluster",
      startedAt: now,
      taskStartedAt: null,
      expiresAt: "2026-07-19T08:00:00.000Z",
      publicIp: null,
      connectCommand: null,
      sessionName: `private-asa-${mapId}`,
      eventModId: null,
      maxPlayers: 4,
      idleTimeoutMinutes: 30,
      idleSince: null,
      lastHeartbeatAt: null,
      startedByDiscordUserId: "user",
      startedFromChannelId: "channel",
      readyAt: null,
      lastBackupAt: null,
      lastStopReason: null,
      lastEcsEventVersion: null,
      reservations,
      updatedAt: now,
    },
    operation: {
      pk: `OPERATION#${runId}` as const,
      runId,
      mapId,
      phase: "CLAIMED" as const,
      taskArn: null,
      reservations,
      createdAt: now,
      updatedAt: now,
      ttl: 1,
    },
    maxConcurrentMaps: 2,
    monthlyRuntimeSecondsLimit: 80 * 3600,
    schemaVersion: 2,
  };
}

beforeEach(() => mocks.send.mockReset().mockResolvedValue({}));

describe("StateStore", () => {
  it("reads every page of each stale operation phase without scanning the table", async () => {
    mocks.send
      .mockResolvedValueOnce({ Items: [{ pk: "OPERATION#claimed-1" }], LastEvaluatedKey: { phase: "CLAIMED", updatedAt: "cursor" } })
      .mockResolvedValueOnce({ Items: [{ pk: "OPERATION#claimed-2" }] })
      .mockResolvedValueOnce({ Items: [{ pk: "OPERATION#started-1" }] });
    const store = new StateStore("table");

    await expect(store.getStaleOperations(["CLAIMED", "TASK_STARTED"], "2026-07-19T00:00:00.000Z")).resolves.toEqual([
      { pk: "OPERATION#claimed-1" },
      { pk: "OPERATION#claimed-2" },
      { pk: "OPERATION#started-1" },
    ]);

    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.send.mock.calls[0][0].input).not.toHaveProperty("ExclusiveStartKey");
    expect(mocks.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ phase: "CLAIMED", updatedAt: "cursor" });
    expect(mocks.send.mock.calls[2][0].input.ExpressionAttributeValues[":phase"]).toBe("TASK_STARTED");
  });

  it("claims a map, cluster slot, budget reservation, and operation atomically", async () => {
    const store = new StateStore("table");
    await expect(store.reserveMapStart(startParams("the-island", "run-island-12345678"))).resolves.toBe(true);
    const command = mocks.send.mock.calls[0][0] as { input: { TransactItems: Array<Record<string, unknown>> } };
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems[0]).toMatchObject({
      Put: {
        Item: { pk: "MAP#the-island" },
        ConditionExpression: "attribute_not_exists(pk) OR #status IN (:stopped, :error)",
      },
    });
    expect(command.input.TransactItems[1]).toMatchObject({
      Update: {
        Key: { pk: "CLUSTER" },
        ConditionExpression: expect.stringContaining("activeCount < :max"),
      },
    });
    expect(command.input.TransactItems[2]).toMatchObject({
      Update: {
        Key: { pk: "BUDGET#2026-07" },
        UpdateExpression: expect.stringContaining("reservedRuntimeSeconds"),
      },
    });
    expect(command.input.TransactItems[3]).toMatchObject({ Put: { Item: { pk: "OPERATION#run-island-12345678" } } });
  });

  it("uses independent Map keys while sharing the same conditional cluster limit", async () => {
    const store = new StateStore("table");
    await store.reserveMapStart(startParams("the-island"));
    await store.reserveMapStart(startParams("scorched-earth"));
    const commands = mocks.send.mock.calls.map(([command]) => command.input.TransactItems);
    expect(commands[0][0].Put.Item.pk).toBe("MAP#the-island");
    expect(commands[1][0].Put.Item.pk).toBe("MAP#scorched-earth");
    expect(commands[0][1].Update.Key).toEqual({ pk: "CLUSTER" });
    expect(commands[1][1].Update.Key).toEqual({ pk: "CLUSTER" });
  });

  it("reports a raced duplicate, concurrency limit, or budget condition as a rejected reservation", async () => {
    mocks.send.mockRejectedValueOnce({ name: "TransactionCanceledException" });
    const store = new StateStore("table");
    await expect(store.reserveMapStart(startParams("the-island"))).resolves.toBe(false);
  });

  it("reattaches early ECS events to STARTING or RUNNING only for the same generation", async () => {
    const store = new StateStore("table");
    await expect(store.attachStartedTask("the-island", "run-island-12345678", "task-1")).resolves.toBe(true);
    const command = mocks.send.mock.calls[0][0] as { input: { TransactItems: Array<Record<string, unknown>> } };
    expect(command.input.TransactItems[0]).toMatchObject({
      Update: {
        Key: { pk: "MAP#the-island" },
        ConditionExpression: expect.stringContaining("runId = :runId AND #status IN (:starting, :running)"),
      },
    });
    expect(command.input.TransactItems[1]).toMatchObject({ Update: { Key: { pk: "OPERATION#run-island-12345678" } } });
  });

  it("rolls back the Map, cluster slot, budget reservation, and operation atomically", async () => {
    const store = new StateStore("table");
    await expect(
      store.rollbackMapStart(
        "the-island",
        "run-island-12345678",
        [{ budgetPk: "BUDGET#2026-07", runtimeSeconds: 28_800 }],
        "RUN_TASK_FAILED",
      ),
    ).resolves.toBe(true);
    const command = mocks.send.mock.calls[0][0] as { input: { TransactItems: Array<Record<string, unknown>> } };
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems[0]).toMatchObject({
      Update: {
        Key: { pk: "MAP#the-island" },
        ConditionExpression: expect.stringContaining("#status IN (:starting, :running, :stopping)"),
      },
    });
    expect(command.input.TransactItems[1]).toMatchObject({ Update: { Key: { pk: "CLUSTER" } } });
    expect(command.input.TransactItems[2]).toMatchObject({ Update: { Key: { pk: "BUDGET#2026-07" } } });
    expect(command.input.TransactItems[3]).toMatchObject({ Update: { Key: { pk: "OPERATION#run-island-12345678" } } });
  });

  it("settles a Map task, reservations, cluster count, and operation atomically", async () => {
    const store = new StateStore("table");
    await expect(
      store.settleStoppedMapTask({
        mapId: "the-island",
        runId: "run-island-12345678",
        taskArn: "task-1",
        reservations: [
          { budgetPk: "BUDGET#2026-07", runtimeSeconds: 7200 },
          { budgetPk: "BUDGET#2026-08", runtimeSeconds: 7200 },
        ],
        budgets: [
          { budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600, estimatedCostJpy: 52, estimatedCostUsd: 52 / 150 },
          { budgetPk: "BUDGET#2026-08", runtimeSeconds: 7200, estimatedCostJpy: 104, estimatedCostUsd: 104 / 150 },
        ],
        reason: "USER_REQUEST",
        eventVersion: 9,
      }),
    ).resolves.toBe(true);

    const command = mocks.send.mock.calls[0][0] as { input: { TransactItems: Array<Record<string, unknown>> } };
    expect(command.input.TransactItems).toHaveLength(6);
    expect(command.input.TransactItems[0]).toMatchObject({
      Put: { Item: { pk: "TASK_SETTLEMENT#task-1" }, ConditionExpression: "attribute_not_exists(pk)" },
    });
    expect(command.input.TransactItems[1]).toMatchObject({ Update: { Key: { pk: "BUDGET#2026-07" } } });
    expect(command.input.TransactItems[2]).toMatchObject({ Update: { Key: { pk: "BUDGET#2026-08" } } });
    expect(command.input.TransactItems[3]).toMatchObject({
      Update: {
        Key: { pk: "MAP#the-island" },
        ConditionExpression: expect.stringContaining("lastEcsEventVersion < :version"),
      },
    });
    expect(command.input.TransactItems[4]).toMatchObject({ Update: { Key: { pk: "CLUSTER" } } });
    expect(command.input.TransactItems[5]).toMatchObject({ Update: { Key: { pk: "OPERATION#run-island-12345678" } } });
  });

  it("treats a canceled duplicate settlement as already processed", async () => {
    mocks.send.mockRejectedValueOnce({ name: "TransactionCanceledException", message: "duplicate" });
    const store = new StateStore("table");

    await expect(
      store.settleStoppedMapTask({
        mapId: "the-island",
        runId: "run-island-12345678",
        taskArn: "task-1",
        reservations: [],
        budgets: [],
        reason: "USER_REQUEST",
        eventVersion: 9,
      }),
    ).resolves.toBe(false);
  });

  it("updates idle state only while the same task is running", async () => {
    const store = new StateStore("table");
    await expect(
      store.updateRunningIdleState("the-island", "run-island-12345678", "task-1", { idleSince: null, lastHeartbeatAt: null }),
    ).resolves.toBe(true);

    const command = mocks.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Key: { pk: "MAP#the-island" },
      ConditionExpression: "#status = :running AND runId = :runId AND taskArn = :taskArn",
      ExpressionAttributeValues: expect.objectContaining({
        ":running": "RUNNING",
        ":runId": "run-island-12345678",
        ":taskArn": "task-1",
      }),
    });
  });
});
