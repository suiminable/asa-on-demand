import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.send }) },
  GetCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  PutCommand: class {
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

beforeEach(() => mocks.send.mockReset().mockResolvedValue({}));

describe("StateStore", () => {
  it("settles all month slices atomically behind an idempotency marker", async () => {
    const store = new StateStore("table");
    await expect(
      store.settleStoppedTask({
        taskArn: "task-1",
        budgets: [
          { budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600, estimatedCostJpy: 52, estimatedCostUsd: 52 / 150 },
          { budgetPk: "BUDGET#2026-08", runtimeSeconds: 7200, estimatedCostJpy: 104, estimatedCostUsd: 104 / 150 },
        ],
        reason: "USER_REQUEST",
      }),
    ).resolves.toBe(true);

    const command = mocks.send.mock.calls[0][0] as { input: { TransactItems: Array<Record<string, unknown>> } };
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems[0]).toMatchObject({
      Put: { Item: { pk: "TASK_SETTLEMENT#task-1" }, ConditionExpression: "attribute_not_exists(pk)" },
    });
    expect(command.input.TransactItems[1]).toMatchObject({ Update: { Key: { pk: "BUDGET#2026-07" } } });
    expect(command.input.TransactItems[2]).toMatchObject({ Update: { Key: { pk: "BUDGET#2026-08" } } });
    expect(command.input.TransactItems[3]).toMatchObject({ Update: { Key: { pk: "SERVER" } } });
  });

  it("treats a canceled duplicate settlement as already processed", async () => {
    mocks.send.mockRejectedValueOnce({ name: "TransactionCanceledException", message: "duplicate" });
    const store = new StateStore("table");

    await expect(store.settleStoppedTask({ taskArn: "task-1", budgets: [], reason: "USER_REQUEST" })).resolves.toBe(false);
  });

  it("updates idle state only while the same task is running", async () => {
    const store = new StateStore("table");
    await expect(store.updateRunningIdleState("task-1", { idleSince: null, lastHeartbeatAt: null })).resolves.toBe(true);

    const command = mocks.send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      ConditionExpression: "#status = :running AND taskArn = :taskArn",
      ExpressionAttributeValues: expect.objectContaining({ ":running": "RUNNING", ":taskArn": "task-1" }),
    });
  });
});
