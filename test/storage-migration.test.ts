import { type CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { type DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { DescribeTasksCommand, type ECSClient, ListTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";
import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  parseStorageMigrationArguments,
  runStorageMigration,
  type StorageMigrationArguments,
  type StorageMigrationClients,
} from "../src/operations/storage-migration.js";

const stackOutputs = [
  ["AsaClusterArn", "arn:aws:ecs:ap-northeast-1:123456789012:cluster/fixture"],
  ["AsaClusterId", "cluster-fixture"],
  ["AsaMigrationTaskDefinitionArn", "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/migration:1"],
  ["AsaSecurityGroupId", "sg-fixture"],
  ["AsaPublicSubnetIds", "subnet-a,subnet-b"],
  ["AsaStateBucketName", "fixture-bucket"],
  ["AsaStateTableName", "fixture-table"],
  ["AsaStateSchemaVersion", "2"],
  ["AsaResourcePrefix", "fixture/"],
] as const;

function argumentsFor(overrides: Partial<StorageMigrationArguments> = {}): StorageMigrationArguments {
  return {
    stackName: "fixture-stack",
    mode: "migrate-parallel",
    clusterId: "cluster-fixture",
    mapIds: ["the-island", "scorched-earth"],
    allowOverwrite: false,
    dryRun: false,
    waitTimeoutSeconds: 7200,
    ...overrides,
  };
}

interface ClientFixture {
  clients: StorageMigrationClients;
  cloudFormationSend: ReturnType<typeof vi.fn>;
  dynamodbSend: ReturnType<typeof vi.fn>;
  ecsSend: ReturnType<typeof vi.fn>;
  s3Send: ReturnType<typeof vi.fn>;
}

function clientFixture(options: { runningTask?: boolean; markerMapIds?: string[] } = {}): ClientFixture {
  const cloudFormationSend = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeStacksCommand) {
      return { Stacks: [{ Outputs: stackOutputs.map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
    }
    throw new Error(`Unexpected CloudFormation command: ${String(command)}`);
  });
  const dynamodbSend = vi.fn(async (command: unknown) => {
    if (command instanceof GetItemCommand) return { Item: { activeCount: { N: "0" } } };
    if (command instanceof UpdateItemCommand) return {};
    throw new Error(`Unexpected DynamoDB command: ${String(command)}`);
  });
  const ecsSend = vi.fn(async (command: unknown) => {
    if (command instanceof ListTasksCommand) {
      return command.input.desiredStatus === "RUNNING" && options.runningTask ? { taskArns: ["arn:task/running"] } : { taskArns: [] };
    }
    if (command instanceof RunTaskCommand) {
      return { tasks: [{ taskArn: "arn:aws:ecs:ap-northeast-1:123456789012:task/migration-fixture" }] };
    }
    if (command instanceof DescribeTasksCommand) {
      return {
        tasks: [
          {
            taskArn: command.input.tasks?.[0],
            stoppedReason: "Essential container in task exited",
            containers: [{ name: "AsaServerContainer", exitCode: 0 }],
          },
        ],
      };
    }
    throw new Error(`Unexpected ECS command: ${String(command)}`);
  });
  const s3Send = vi.fn(async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      return {
        Body: {
          transformToString: async () =>
            JSON.stringify({
              schemaVersion: 2,
              clusterId: "cluster-fixture",
              mapIds: options.markerMapIds ?? ["the-island", "scorched-earth"],
            }),
        },
      };
    }
    if (command instanceof HeadObjectCommand) return { ContentLength: 42 };
    throw new Error(`Unexpected S3 command: ${String(command)}`);
  });

  return {
    clients: {
      cloudFormation: { send: cloudFormationSend } as unknown as CloudFormationClient,
      dynamodb: { send: dynamodbSend } as unknown as DynamoDBClient,
      ecs: { send: ecsSend } as unknown as ECSClient,
      s3: { send: s3Send } as unknown as S3Client,
    },
    cloudFormationSend,
    dynamodbSend,
    ecsSend,
    s3Send,
  };
}

describe("storage migration arguments", () => {
  it("accepts the subcommand form, profile, and dry-run", () => {
    const parsed = parseStorageMigrationArguments([
      "migrate-parallel",
      "--stack-name",
      "fixture-stack",
      "--cluster-id",
      "cluster-fixture",
      "--maps",
      "the-island,scorched-earth",
      "--profile",
      "suiminable",
      "--dry-run",
    ]);
    expect(parsed).toEqual({
      help: false,
      arguments: expect.objectContaining({
        mode: "migrate-parallel",
        mapIds: ["the-island", "scorched-earth"],
        profile: "suiminable",
        dryRun: true,
      }),
    });
  });

  it("preserves the legacy --mode form and rejects duplicate Map IDs", () => {
    expect(() =>
      parseStorageMigrationArguments([
        "--stack-name",
        "fixture-stack",
        "--mode",
        "migrate-parallel",
        "--cluster-id",
        "cluster-fixture",
        "--maps",
        "the-island,the-island",
      ]),
    ).toThrow("Duplicate mapId: the-island");
  });
});

describe("storage migration workflow", () => {
  it("resolves and validates a dry-run without starting an ECS task", async () => {
    const fixture = clientFixture();
    const log = vi.fn();
    await expect(
      runStorageMigration(argumentsFor({ dryRun: true }), {
        clients: fixture.clients,
        log,
      }),
    ).resolves.toEqual({ dryRun: true });

    expect(fixture.ecsSend.mock.calls.some(([command]) => command instanceof RunTaskCommand)).toBe(false);
    expect(fixture.s3Send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Storage migration plan:"));
    expect(log).toHaveBeenCalledWith("Dry run completed. No AWS resources were changed.");
  });

  it("starts the typed ECS task, verifies its outputs, and initializes schema v2", async () => {
    const fixture = clientFixture();
    const waitForTask = vi.fn(async () => undefined);
    const log = vi.fn();
    const result = await runStorageMigration(argumentsFor(), {
      clients: fixture.clients,
      waitForTask,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      log,
    });

    expect(result).toEqual({ dryRun: false, taskArn: "arn:aws:ecs:ap-northeast-1:123456789012:task/migration-fixture" });
    const runTask = fixture.ecsSend.mock.calls.map(([command]) => command).find((command) => command instanceof RunTaskCommand);
    expect(runTask).toBeInstanceOf(RunTaskCommand);
    if (!(runTask instanceof RunTaskCommand)) throw new Error("RunTask command was not sent.");
    expect(runTask.input).toMatchObject({
      cluster: "arn:aws:ecs:ap-northeast-1:123456789012:cluster/fixture",
      taskDefinition: "arn:aws:ecs:ap-northeast-1:123456789012:task-definition/migration:1",
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "ENABLED",
          subnets: ["subnet-a", "subnet-b"],
          securityGroups: ["sg-fixture"],
        },
      },
    });
    const environment = Object.fromEntries(
      (runTask.input.overrides?.containerOverrides?.[0]?.environment ?? []).map(({ name, value }) => [name, value]),
    );
    expect(environment).toMatchObject({
      ASA_OPERATION_MODE: "migrate-parallel",
      MIGRATION_MAP_IDS: "the-island,scorched-earth",
      S3_RESOURCE_PREFIX: "fixture/",
      LEGACY_S3_SAVE_KEY: "fixture/saves/current.tar.zst",
    });
    expect(waitForTask).toHaveBeenCalledWith(
      fixture.clients.ecs,
      "arn:aws:ecs:ap-northeast-1:123456789012:cluster/fixture",
      "arn:aws:ecs:ap-northeast-1:123456789012:task/migration-fixture",
      7200,
    );
    expect(fixture.s3Send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(2);
    const update = fixture.dynamodbSend.mock.calls.map(([command]) => command).find((command) => command instanceof UpdateItemCommand);
    expect(update).toBeInstanceOf(UpdateItemCommand);
    if (!(update instanceof UpdateItemCommand)) throw new Error("UpdateItem command was not sent.");
    expect(update.input).toMatchObject({
      TableName: "fixture-table",
      ConditionExpression: "attribute_not_exists(activeCount) OR activeCount = :zero",
      ExpressionAttributeValues: { ":now": { S: "2026-07-22T00:00:00Z" } },
    });
  });

  it("refuses to run while a game task is active", async () => {
    const fixture = clientFixture({ runningTask: true });
    await expect(runStorageMigration(argumentsFor(), { clients: fixture.clients, log: () => undefined })).rejects.toThrow(
      "RUNNING ECS tasks: arn:task/running",
    );
    expect(fixture.ecsSend.mock.calls.some(([command]) => command instanceof RunTaskCommand)).toBe(false);
  });

  it("does not update DynamoDB when the migration marker does not match", async () => {
    const fixture = clientFixture({ markerMapIds: ["the-island"] });
    await expect(
      runStorageMigration(argumentsFor(), {
        clients: fixture.clients,
        waitForTask: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toThrow("Migration marker did not match");
    expect(fixture.dynamodbSend.mock.calls.some(([command]) => command instanceof UpdateItemCommand)).toBe(false);
  });

  it.each([
    {
      name: "export-legacy",
      arguments: argumentsFor({
        mode: "export-legacy",
        mapIds: [],
        rollbackMap: "the-island",
        rollbackKey: "fixture/rollback/current.tar.zst",
      }),
      expectedEnvironment: {
        ASA_OPERATION_MODE: "export-legacy",
        ROLLBACK_MAP_ID: "the-island",
        ROLLBACK_S3_SAVE_KEY: "fixture/rollback/current.tar.zst",
      },
    },
    {
      name: "restore-cluster",
      arguments: argumentsFor({
        mode: "restore-cluster",
        mapIds: [],
        restoredClusterPath: "aws-backup-restore_20260722/cluster-data/clusters/cluster-fixture",
        allowOverwrite: true,
      }),
      expectedEnvironment: {
        ASA_OPERATION_MODE: "restore-cluster",
        RESTORED_CLUSTER_PATH: "aws-backup-restore_20260722/cluster-data/clusters/cluster-fixture",
        MIGRATION_ALLOW_OVERWRITE: "true",
      },
    },
  ])("passes typed $name settings without parallel-migration post-processing", async ({ arguments: input, expectedEnvironment }) => {
    const fixture = clientFixture();
    await runStorageMigration(input, {
      clients: fixture.clients,
      waitForTask: async () => undefined,
      log: () => undefined,
    });

    const runTask = fixture.ecsSend.mock.calls.map(([command]) => command).find((command) => command instanceof RunTaskCommand);
    if (!(runTask instanceof RunTaskCommand)) throw new Error("RunTask command was not sent.");
    const environment = Object.fromEntries(
      (runTask.input.overrides?.containerOverrides?.[0]?.environment ?? []).map(({ name, value }) => [name, value]),
    );
    expect(environment).toMatchObject(expectedEnvironment);
    expect(fixture.s3Send).not.toHaveBeenCalled();
    expect(fixture.dynamodbSend.mock.calls.some(([command]) => command instanceof UpdateItemCommand)).toBe(false);
  });
});
