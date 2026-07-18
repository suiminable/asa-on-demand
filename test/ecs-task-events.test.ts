import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServer: vi.fn(),
  settleStoppedTask: vi.fn(),
  updateServerStatus: vi.fn(),
  postWebhook: vi.fn(),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  DescribeTasksCommand: class {},
  ECSClient: class {
    send = vi.fn();
  },
}));
vi.mock("@aws-sdk/client-ec2", () => ({
  DescribeNetworkInterfacesCommand: class {},
  EC2Client: class {
    send = vi.fn();
  },
}));
vi.mock("@aws-sdk/client-route-53", () => ({
  ChangeResourceRecordSetsCommand: class {},
  Route53Client: class {
    send = vi.fn();
  },
}));

vi.mock("../src/shared/config.js", () => ({
  requireEnv: (name: string) =>
    ({ TABLE_NAME: "table", CLUSTER_ARN: "cluster", NOTIFICATION_WEBHOOK_SECRET_NAME: "webhook-secret" })[name] ?? name,
  getSecret: vi.fn().mockResolvedValue("https://example.invalid/webhook"),
}));
vi.mock("../src/shared/discord.js", () => ({ postWebhook: mocks.postWebhook }));
vi.mock("../src/shared/state.js", () => ({
  StateStore: class {
    getServer = mocks.getServer;
    settleStoppedTask = mocks.settleStoppedTask;
    updateServerStatus = mocks.updateServerStatus;
  },
}));

import { handler } from "../src/lambdas/ecs-task-events/index.js";

beforeEach(() => {
  mocks.getServer.mockReset().mockResolvedValue({ status: "STOPPING", lastBackupAt: null });
  mocks.settleStoppedTask.mockReset().mockResolvedValue(true);
  mocks.updateServerStatus.mockReset().mockResolvedValue(undefined);
  mocks.postWebhook.mockReset().mockResolvedValue(undefined);
});

describe("ECS task settlement", () => {
  it("settles a task into each JST month it spans", async () => {
    await handler({
      detail: {
        clusterArn: "cluster",
        taskArn: "task-1",
        lastStatus: "STOPPED",
        startedAt: "2026-07-31T14:00:00.000Z",
        stoppedAt: "2026-07-31T17:00:00.000Z",
        stoppedReason: "Task stopped by user",
      },
    } as never);

    expect(mocks.settleStoppedTask).toHaveBeenCalledWith({
      taskArn: "task-1",
      budgets: [
        { budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600, estimatedCostJpy: 52, estimatedCostUsd: 52 / 150 },
        { budgetPk: "BUDGET#2026-08", runtimeSeconds: 7200, estimatedCostJpy: 104, estimatedCostUsd: 104 / 150 },
      ],
      reason: "Task stopped by user",
    });
  });
});
