import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DOMAIN_NAME = "example.test";
  process.env.HOSTED_ZONE_ID = "zone-1";
  return {
    ecsSend: vi.fn(),
    ec2Send: vi.fn(),
    route53Send: vi.fn(),
    schedulerSend: vi.fn(),
    s3Send: vi.fn(),
    getMap: vi.fn(),
    settleStoppedMapTask: vi.fn(),
    updateMapFromRunningEvent: vi.fn(),
    updateRunningConnectCommand: vi.fn(),
    postWebhook: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-ecs", () => ({
  DescribeTasksCommand: class {},
  ECSClient: class {
    send = mocks.ecsSend;
  },
}));
vi.mock("@aws-sdk/client-ec2", () => ({
  DescribeNetworkInterfacesCommand: class {},
  EC2Client: class {
    send = mocks.ec2Send;
  },
}));
vi.mock("@aws-sdk/client-route-53", () => ({
  ChangeResourceRecordSetsCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  Route53Client: class {
    send = mocks.route53Send;
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
  getSecret: vi.fn().mockResolvedValue("https://example.invalid/webhook"),
}));
vi.mock("../src/shared/discord.js", () => ({ postWebhook: mocks.postWebhook }));
vi.mock("../src/shared/state.js", () => ({
  StateStore: class {
    getMap = mocks.getMap;
    settleStoppedMapTask = mocks.settleStoppedMapTask;
    updateMapFromRunningEvent = mocks.updateMapFromRunningEvent;
    updateRunningConnectCommand = mocks.updateRunningConnectCommand;
  },
}));

import { handler } from "../src/lambdas/ecs-task-events/index.js";

beforeEach(() => {
  mocks.getMap.mockReset().mockResolvedValue({
    mapId: "the-island",
    runId: "run-island-12345678",
    taskArn: "task-1",
    status: "STOPPING",
    publicIp: "203.0.113.10",
    reservations: [
      { budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600 },
      { budgetPk: "BUDGET#2026-08", runtimeSeconds: 10_800 },
    ],
  });
  mocks.settleStoppedMapTask.mockReset().mockResolvedValue(true);
  mocks.updateMapFromRunningEvent.mockReset().mockResolvedValue({ sessionName: "private-asa-island" });
  mocks.updateRunningConnectCommand.mockReset().mockResolvedValue(true);
  mocks.ecsSend.mockReset().mockResolvedValue({
    tasks: [
      {
        attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "networkInterfaceId", value: "eni-1" }] }],
      },
    ],
  });
  mocks.ec2Send.mockReset().mockResolvedValue({ NetworkInterfaces: [{ Association: { PublicIp: "203.0.113.10" } }] });
  mocks.route53Send.mockReset().mockResolvedValue({});
  mocks.schedulerSend.mockReset().mockResolvedValue({});
  mocks.s3Send.mockReset().mockResolvedValue({
    Body: { transformToString: async () => JSON.stringify({ runId: "run-island-12345678", lastBackupAt: "2026-07-31T17:00:00Z" }) },
  });
  mocks.postWebhook.mockReset().mockResolvedValue(undefined);
});

describe("generation-aware ECS task settlement", () => {
  it("settles runtime slices and releases the matching reservation", async () => {
    await handler({
      detail: {
        clusterArn: "cluster",
        taskArn: "task-1",
        group: "asa-map:the-island:run-island-12345678",
        version: 7,
        lastStatus: "STOPPED",
        startedAt: "2026-07-31T14:00:00.000Z",
        stoppedAt: "2026-07-31T17:00:00.000Z",
        stoppedReason: "Task stopped by user",
      },
    } as never);

    expect(mocks.settleStoppedMapTask).toHaveBeenCalledWith({
      mapId: "the-island",
      runId: "run-island-12345678",
      taskArn: "task-1",
      reservations: [
        { budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600 },
        { budgetPk: "BUDGET#2026-08", runtimeSeconds: 10_800 },
      ],
      budgets: [
        { budgetPk: "BUDGET#2026-07", runtimeSeconds: 3600, estimatedCostJpy: 52, estimatedCostUsd: 52 / 150 },
        { budgetPk: "BUDGET#2026-08", runtimeSeconds: 7200, estimatedCostJpy: 104, estimatedCostUsd: 104 / 150 },
      ],
      reason: "Task stopped by user",
      eventVersion: 7,
      lastBackupAt: "2026-07-31T17:00:00Z",
    });
    expect(mocks.schedulerSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Name: "asa-default-the-island-auto-stop", GroupName: "default" } }),
    );
    expect(mocks.route53Send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ChangeBatch: {
            Changes: [
              {
                Action: "DELETE",
                ResourceRecordSet: {
                  Name: "the-island.example.test",
                  Type: "A",
                  TTL: 60,
                  ResourceRecords: [{ Value: "203.0.113.10" }],
                },
              },
            ],
          },
        }),
      }),
    );
  });

  it("ignores unrelated task groups before touching map state", async () => {
    await handler({ detail: { clusterArn: "cluster", taskArn: "task-x", group: "service:other", lastStatus: "STOPPED" } } as never);
    expect(mocks.getMap).not.toHaveBeenCalled();
    expect(mocks.settleStoppedMapTask).not.toHaveBeenCalled();
  });

  it("ignores a stopped event from an older run", async () => {
    await handler({
      detail: {
        clusterArn: "cluster",
        taskArn: "task-old",
        group: "asa-map:the-island:old-run-12345678",
        lastStatus: "STOPPED",
      },
    } as never);
    expect(mocks.settleStoppedMapTask).not.toHaveBeenCalled();
    expect(mocks.schedulerSend).not.toHaveBeenCalled();
    expect(mocks.route53Send).not.toHaveBeenCalled();
  });

  it("does not delete DNS when STOPPED settlement loses a version race", async () => {
    mocks.settleStoppedMapTask.mockResolvedValue(false);

    await handler({
      detail: {
        clusterArn: "cluster",
        taskArn: "task-1",
        group: "asa-map:the-island:run-island-12345678",
        version: 6,
        lastStatus: "STOPPED",
        startedAt: "2026-07-19T00:00:00.000Z",
        stoppedAt: "2026-07-19T01:00:00.000Z",
      },
    } as never);

    expect(mocks.schedulerSend).toHaveBeenCalledOnce();
    expect(mocks.route53Send).not.toHaveBeenCalled();
  });

  it("rejects a stale RUNNING event before it can update DNS", async () => {
    mocks.updateMapFromRunningEvent.mockResolvedValue(undefined);

    await handler({
      detail: {
        clusterArn: "cluster",
        taskArn: "task-old",
        group: "asa-map:the-island:old-run-12345678",
        version: 8,
        lastStatus: "RUNNING",
      },
    } as never);

    expect(mocks.updateMapFromRunningEvent).toHaveBeenCalled();
    expect(mocks.route53Send).not.toHaveBeenCalled();
    expect(mocks.postWebhook).not.toHaveBeenCalled();
  });

  it("updates DNS only after claiming the current RUNNING event", async () => {
    await handler({
      detail: {
        clusterArn: "cluster",
        taskArn: "task-1",
        group: "asa-map:the-island:run-island-12345678",
        version: 9,
        lastStatus: "RUNNING",
        startedAt: "2026-07-19T00:00:00.000Z",
      },
    } as never);

    expect(mocks.updateMapFromRunningEvent.mock.invocationCallOrder[0]).toBeLessThan(mocks.route53Send.mock.invocationCallOrder[0]);
    expect(mocks.updateRunningConnectCommand).toHaveBeenCalledWith({
      mapId: "the-island",
      runId: "run-island-12345678",
      taskArn: "task-1",
      eventVersion: 9,
      connectCommand: "open the-island.example.test:7777?Password=YOUR_SERVER_PASSWORD",
    });
    expect(mocks.postWebhook).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Session: private-asa-island"));
  });
});
