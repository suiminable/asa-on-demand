import { type CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { type DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { DescribeTasksCommand, type ECSClient, ListTasksCommand, RunTaskCommand, waitUntilTasksStopped } from "@aws-sdk/client-ecs";
import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";

export const STORAGE_MIGRATION_MODES = ["migrate-parallel", "export-legacy", "restore-cluster"] as const;
export type StorageMigrationMode = (typeof STORAGE_MIGRATION_MODES)[number];

export interface StorageMigrationArguments {
  stackName: string;
  mode: StorageMigrationMode;
  clusterId: string;
  mapIds: string[];
  rollbackMap?: string;
  rollbackKey?: string;
  restoredClusterPath?: string;
  profile?: string;
  region?: string;
  allowOverwrite: boolean;
  dryRun: boolean;
  waitTimeoutSeconds: number;
}

export type ParsedStorageMigrationArguments = { help: true } | { help: false; arguments: StorageMigrationArguments };

export interface StorageMigrationClients {
  cloudFormation: CloudFormationClient;
  dynamodb: DynamoDBClient;
  ecs: ECSClient;
  s3: S3Client;
}

interface StackResources {
  clusterArn: string;
  clusterId: string;
  migrationTaskDefinitionArn: string;
  securityGroupId: string;
  subnetIds: string[];
  stateBucketName: string;
  stateTableName: string;
  stateSchemaVersion: string;
  resourcePrefix: string;
}

export interface StorageMigrationDependencies {
  clients: StorageMigrationClients;
  log?: (message: string) => void;
  now?: () => Date;
  waitForTask?: (ecs: ECSClient, clusterArn: string, taskArn: string, timeoutSeconds: number) => Promise<void>;
}

export interface StorageMigrationResult {
  dryRun: boolean;
  taskArn?: string;
}

const MAP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLUSTER_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const STORAGE_MIGRATION_USAGE = `Usage:
  pnpm run storage:migration -- migrate-parallel --stack-name STACK \\
    --cluster-id CLUSTER_ID --maps the-island,scorched-earth [--profile PROFILE] [--region REGION]

  pnpm run storage:migration -- export-legacy --stack-name STACK \\
    --cluster-id CLUSTER_ID --rollback-map the-island [--rollback-key KEY] [--profile PROFILE] [--region REGION]

  pnpm run storage:migration -- restore-cluster --stack-name STACK \\
    --cluster-id CLUSTER_ID --restored-cluster-path aws-backup-restore_TIMESTAMP/cluster-data/clusters/CLUSTER_ID

The legacy --mode MODE form is also accepted. Use --dry-run to resolve the stack
and run read-only preflight checks without starting a task. The task refuses to
overwrite a destination by default; use --allow-overwrite only after taking the
backups described in the runbook.`;

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseTimeout(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Migration wait timeout must be an integer from 60 through 86400 seconds.");
  const parsed = Number(value);
  if (parsed < 60 || parsed > 86_400) {
    throw new Error("Migration wait timeout must be an integer from 60 through 86400 seconds.");
  }
  return parsed;
}

function isMode(value: string): value is StorageMigrationMode {
  return STORAGE_MIGRATION_MODES.some((mode) => mode === value);
}

function parseMapIds(value: string): string[] {
  const mapIds = value.split(",");
  if (mapIds.length === 0 || mapIds.some((mapId) => !MAP_ID_PATTERN.test(mapId))) {
    throw new Error("--maps must be a comma-separated list of mapId values without whitespace or empty entries.");
  }
  const duplicate = mapIds.find((mapId, index) => mapIds.indexOf(mapId) !== index);
  if (duplicate) throw new Error(`Duplicate mapId: ${duplicate}`);
  return mapIds;
}

export function parseStorageMigrationArguments(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ParsedStorageMigrationArguments {
  let stackName = "";
  let mode: StorageMigrationMode | undefined;
  let clusterId = "";
  let mapIds: string[] = [];
  let rollbackMap: string | undefined;
  let rollbackKey: string | undefined;
  let restoredClusterPath: string | undefined;
  let profile: string | undefined;
  let region: string | undefined;
  let allowOverwrite = false;
  let dryRun = false;
  let waitTimeoutSeconds = parseTimeout(environment.MIGRATION_WAIT_TIMEOUT_SECONDS ?? "7200");

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--help" || value === "-h") return { help: true };
    if (isMode(value) && !mode) {
      mode = value;
      continue;
    }
    if (value === "--allow-overwrite") {
      allowOverwrite = true;
      continue;
    }
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }

    const next = requiredValue(argv, index, value);
    switch (value) {
      case "--stack-name":
        stackName = next;
        break;
      case "--mode":
        if (!isMode(next)) throw new Error(`Unsupported migration mode: ${next}`);
        if (mode && mode !== next) throw new Error(`Migration mode was specified more than once: ${mode}, ${next}`);
        mode = next;
        break;
      case "--cluster-id":
        clusterId = next;
        break;
      case "--maps":
        mapIds = parseMapIds(next);
        break;
      case "--rollback-map":
        rollbackMap = next;
        break;
      case "--rollback-key":
        rollbackKey = next;
        break;
      case "--restored-cluster-path":
        restoredClusterPath = next;
        break;
      case "--profile":
        profile = next;
        break;
      case "--region":
        region = next;
        break;
      case "--wait-timeout-seconds":
        waitTimeoutSeconds = parseTimeout(next);
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
    index += 1;
  }

  if (!stackName) throw new Error("--stack-name is required.");
  if (!mode) throw new Error("A migration mode is required.");
  if (!CLUSTER_ID_PATTERN.test(clusterId)) throw new Error("Invalid cluster ID.");
  if (mode === "migrate-parallel" && mapIds.length === 0) throw new Error("--maps is required for migrate-parallel.");
  if (mode === "export-legacy" && (!rollbackMap || !MAP_ID_PATTERN.test(rollbackMap))) {
    throw new Error("--rollback-map must be a valid mapId for export-legacy.");
  }
  if (mode === "restore-cluster" && !restoredClusterPath) {
    throw new Error("--restored-cluster-path is required for restore-cluster.");
  }

  return {
    help: false,
    arguments: {
      stackName,
      mode,
      clusterId,
      mapIds,
      rollbackMap,
      rollbackKey,
      restoredClusterPath,
      profile,
      region,
      allowOverwrite,
      dryRun,
      waitTimeoutSeconds,
    },
  };
}

function requireOutput(outputs: Map<string, string>, key: string): string {
  const value = outputs.get(key);
  if (!value) throw new Error(`Stack output ${key} is missing.`);
  return value;
}

function normalizeResourcePrefix(value: string): string {
  if (value === "/") return "";
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed.split("/").some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "..")) {
    throw new Error(`Stack output AsaResourcePrefix is invalid: ${value}`);
  }
  return `${trimmed}/`;
}

async function loadStackResources(cloudFormation: CloudFormationClient, stackName: string): Promise<StackResources> {
  const response = await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (!stack) throw new Error(`CloudFormation stack was not found: ${stackName}`);
  const outputs = new Map(
    (stack.Outputs ?? []).flatMap((output) =>
      output.OutputKey && output.OutputValue ? [[output.OutputKey, output.OutputValue] as const] : [],
    ),
  );
  const subnetIds = requireOutput(outputs, "AsaPublicSubnetIds").split(",").filter(Boolean);
  if (subnetIds.length === 0) throw new Error("Stack output AsaPublicSubnetIds contains no subnet IDs.");
  return {
    clusterArn: requireOutput(outputs, "AsaClusterArn"),
    clusterId: requireOutput(outputs, "AsaClusterId"),
    migrationTaskDefinitionArn: requireOutput(outputs, "AsaMigrationTaskDefinitionArn"),
    securityGroupId: requireOutput(outputs, "AsaSecurityGroupId"),
    subnetIds,
    stateBucketName: requireOutput(outputs, "AsaStateBucketName"),
    stateTableName: requireOutput(outputs, "AsaStateTableName"),
    stateSchemaVersion: requireOutput(outputs, "AsaStateSchemaVersion"),
    resourcePrefix: normalizeResourcePrefix(requireOutput(outputs, "AsaResourcePrefix")),
  };
}

async function assertEnvironmentStopped(clients: StorageMigrationClients, stack: StackResources): Promise<void> {
  const [running, pending, clusterState] = await Promise.all([
    clients.ecs.send(new ListTasksCommand({ cluster: stack.clusterArn, desiredStatus: "RUNNING" })),
    clients.ecs.send(new ListTasksCommand({ cluster: stack.clusterArn, desiredStatus: "PENDING" })),
    clients.dynamodb.send(
      new GetItemCommand({
        TableName: stack.stateTableName,
        Key: { pk: { S: "CLUSTER" } },
        ProjectionExpression: "activeCount",
        ConsistentRead: true,
      }),
    ),
  ]);
  const blockers: string[] = [];
  if ((running.taskArns?.length ?? 0) > 0) blockers.push(`RUNNING ECS tasks: ${running.taskArns?.join(", ")}`);
  if ((pending.taskArns?.length ?? 0) > 0) blockers.push(`PENDING ECS tasks: ${pending.taskArns?.join(", ")}`);
  const activeCount = Number(clusterState.Item?.activeCount?.N ?? "0");
  if (!Number.isFinite(activeCount) || activeCount !== 0) {
    blockers.push(`DynamoDB CLUSTER.activeCount=${clusterState.Item?.activeCount?.N ?? "invalid"}`);
  }
  if (blockers.length > 0) throw new Error(`Storage migration preflight failed:\n- ${blockers.join("\n- ")}`);
}

function migrationEnvironment(arguments_: StorageMigrationArguments, stack: StackResources): Record<string, string> {
  return {
    ASA_OPERATION_MODE: arguments_.mode,
    S3_BUCKET: stack.stateBucketName,
    S3_RESOURCE_PREFIX: stack.resourcePrefix,
    ASA_CLUSTER_ID: arguments_.clusterId,
    LEGACY_S3_SAVE_KEY: `${stack.resourcePrefix}saves/current.tar.zst`,
    MIGRATION_MAP_IDS: arguments_.mapIds.join(","),
    ROLLBACK_MAP_ID: arguments_.rollbackMap ?? "",
    ROLLBACK_S3_SAVE_KEY: arguments_.rollbackKey ?? "",
    RESTORED_CLUSTER_PATH: arguments_.restoredClusterPath ?? "",
    MIGRATION_ALLOW_OVERWRITE: String(arguments_.allowOverwrite),
  };
}

function printPlan(arguments_: StorageMigrationArguments, stack: StackResources, log: (message: string) => void): void {
  const destinations = arguments_.mapIds.map((mapId) => `${stack.resourcePrefix}maps/${mapId}/saves/current.tar.zst`);
  log(
    [
      "Storage migration plan:",
      `  mode: ${arguments_.mode}`,
      `  AWS profile: ${arguments_.profile ?? "default credential chain"}`,
      `  AWS region: ${arguments_.region ?? "default region chain"}`,
      `  stack: ${arguments_.stackName}`,
      `  clusterId: ${arguments_.clusterId}`,
      `  ECS cluster: ${stack.clusterArn}`,
      `  task definition: ${stack.migrationTaskDefinitionArn}`,
      `  state bucket: ${stack.stateBucketName}`,
      `  resource prefix: ${stack.resourcePrefix || "/"}`,
      ...(destinations.length > 0 ? [`  Map archives: ${destinations.join(", ")}`] : []),
      `  allow overwrite: ${arguments_.allowOverwrite}`,
    ].join("\n"),
  );
}

async function defaultWaitForTask(ecs: ECSClient, clusterArn: string, taskArn: string, timeoutSeconds: number): Promise<void> {
  try {
    await waitUntilTasksStopped(
      { client: ecs, maxWaitTime: timeoutSeconds, minDelay: 5, maxDelay: 15 },
      { cluster: clusterArn, tasks: [taskArn] },
    );
  } catch (error) {
    throw new Error(`Timed out or failed while waiting for migration task ${taskArn}.`, { cause: error });
  }
}

interface MigrationMarker {
  schemaVersion: number;
  clusterId: string;
  mapIds: string[];
}

function parseMarker(value: string): MigrationMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Migration marker is not valid JSON.", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    typeof parsed.schemaVersion !== "number" ||
    !("clusterId" in parsed) ||
    typeof parsed.clusterId !== "string" ||
    !("mapIds" in parsed) ||
    !Array.isArray(parsed.mapIds) ||
    !parsed.mapIds.every((mapId) => typeof mapId === "string")
  ) {
    throw new Error("Migration marker has an invalid schema.");
  }
  return { schemaVersion: parsed.schemaVersion, clusterId: parsed.clusterId, mapIds: parsed.mapIds };
}

async function verifyParallelMigration(
  clients: StorageMigrationClients,
  arguments_: StorageMigrationArguments,
  stack: StackResources,
  now: Date,
  log: (message: string) => void,
): Promise<void> {
  const markerKey = `${stack.resourcePrefix}migration/parallel-storage-v2.json`;
  const markerObject = await clients.s3.send(new GetObjectCommand({ Bucket: stack.stateBucketName, Key: markerKey }));
  if (!markerObject.Body) throw new Error(`Migration marker is empty: s3://${stack.stateBucketName}/${markerKey}`);
  const marker = parseMarker(await markerObject.Body.transformToString());
  if (
    marker.schemaVersion !== 2 ||
    marker.clusterId !== arguments_.clusterId ||
    marker.mapIds.length !== arguments_.mapIds.length ||
    marker.mapIds.some((mapId, index) => mapId !== arguments_.mapIds[index])
  ) {
    throw new Error(`Migration marker did not match the requested cluster and Map set: s3://${stack.stateBucketName}/${markerKey}`);
  }

  await Promise.all(
    arguments_.mapIds.map((mapId) =>
      clients.s3.send(
        new HeadObjectCommand({
          Bucket: stack.stateBucketName,
          Key: `${stack.resourcePrefix}maps/${mapId}/saves/current.tar.zst`,
        }),
      ),
    ),
  );
  log(`Verified the migration marker and ${arguments_.mapIds.length} Map archive object(s).`);

  await clients.dynamodb.send(
    new UpdateItemCommand({
      TableName: stack.stateTableName,
      Key: { pk: { S: "CLUSTER" } },
      UpdateExpression:
        "SET activeCount = if_not_exists(activeCount, :zero), maxConcurrentMaps = if_not_exists(maxConcurrentMaps, :one), schemaVersion = :schema, updatedAt = :now",
      ConditionExpression: "attribute_not_exists(activeCount) OR activeCount = :zero",
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":schema": { N: "2" },
        ":now": { S: now.toISOString().replace(/\.000Z$/, "Z") },
      },
    }),
  );
  log("The DynamoDB CLUSTER schema was initialized for schema version 2.");
}

export async function runStorageMigration(
  arguments_: StorageMigrationArguments,
  dependencies: StorageMigrationDependencies,
): Promise<StorageMigrationResult> {
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? (() => new Date());
  const waitForTask = dependencies.waitForTask ?? defaultWaitForTask;
  const { clients } = dependencies;
  const stack = await loadStackResources(clients.cloudFormation, arguments_.stackName);

  if (stack.clusterId !== arguments_.clusterId) {
    throw new Error(
      `Refusing migration: --cluster-id ${arguments_.clusterId} does not match the stack AsaClusterId output ${stack.clusterId}.`,
    );
  }
  if (stack.stateSchemaVersion !== "2") {
    throw new Error(`Refusing migration: stack state schema output is ${stack.stateSchemaVersion}, expected 2.`);
  }
  printPlan(arguments_, stack, log);
  await assertEnvironmentStopped(clients, stack);
  if (arguments_.dryRun) {
    log("Dry run completed. No AWS resources were changed.");
    return { dryRun: true };
  }

  const environment = migrationEnvironment(arguments_, stack);
  const runTask = await clients.ecs.send(
    new RunTaskCommand({
      cluster: stack.clusterArn,
      taskDefinition: stack.migrationTaskDefinitionArn,
      capacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }],
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "ENABLED",
          subnets: stack.subnetIds,
          securityGroups: [stack.securityGroupId],
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "AsaServerContainer",
            environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
          },
        ],
      },
      group: "asa-storage-migration",
    }),
  );
  if ((runTask.failures?.length ?? 0) > 0) {
    throw new Error(`ECS refused the migration task: ${runTask.failures?.map((failure) => failure.reason ?? failure.arn).join(", ")}`);
  }
  const taskArn = runTask.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error("ECS did not return a migration task ARN.");
  log(`Started migration task: ${taskArn}`);

  await waitForTask(clients.ecs, stack.clusterArn, taskArn, arguments_.waitTimeoutSeconds);
  const task = await clients.ecs.send(new DescribeTasksCommand({ cluster: stack.clusterArn, tasks: [taskArn] }));
  const describedTask = task.tasks?.[0];
  if (!describedTask) throw new Error(`ECS did not return migration task details: ${taskArn}`);
  const container = describedTask.containers?.find((value) => value.name === "AsaServerContainer");
  log(`Migration task stopped: exit=${container?.exitCode ?? "unknown"}; reason=${describedTask.stoppedReason ?? "unknown"}`);
  if (container?.exitCode !== 0) throw new Error(`Migration task failed with exit code ${container?.exitCode ?? "unknown"}.`);

  if (arguments_.mode === "migrate-parallel") {
    await verifyParallelMigration(clients, arguments_, stack, now(), log);
  }
  return { dryRun: false, taskArn };
}
