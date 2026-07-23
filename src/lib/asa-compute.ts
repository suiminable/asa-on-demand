import * as cdk from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import type * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { DEFAULT_MAX_PLAYERS } from "../shared/defaults.js";
import { mapStorageKeys } from "../shared/resources.js";

export interface AsaComputeProps {
  vpc: ec2.Vpc;
  clusterFileSystem: efs.FileSystem;
  clusterAccessPoint: efs.AccessPoint;
  clusterAdminAccessPoint: efs.AccessPoint;
  stateBucket: s3.Bucket;
  resourcePrefix: string;
  resourceNameSegment: string;
  region: string;
  cpu: number;
  memoryMiB: number;
  ephemeralStorageGiB: number;
  stopTimeoutSeconds: number;
  asaBuildId: string;
  asaUpdateOnStart: boolean;
  asaClusterId: string;
  notificationWebhookSecretName: string;
  serverPasswordSecretName: string;
  adminPasswordSecretName: string;
}

export interface AsaComputeResources {
  cluster: ecs.Cluster;
  serverRepository: ecr.Repository;
  taskDefinition: ecs.FargateTaskDefinition;
  migrationTaskDefinition: ecs.FargateTaskDefinition;
  executionRole: iam.IRole;
}

function prefixedLogGroupName(resourceNameSegment: string, suffix: string): string {
  return resourceNameSegment ? `/asa/${resourceNameSegment}/${suffix}` : `/asa/${suffix}`;
}

/** Creates ECS/ECR resources directly under the Stack scope to preserve logical IDs. */
export function createAsaCompute(scope: Construct, props: AsaComputeProps): AsaComputeResources {
  const cluster = new ecs.Cluster(scope, "AsaCluster", { vpc: props.vpc });
  cluster.enableFargateCapacityProviders();

  const serverRepository = new ecr.Repository(scope, "AsaServerRepository", {
    repositoryName: props.resourcePrefix ? `asa-${props.resourceNameSegment}-server` : "asa-server",
    emptyOnDelete: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    lifecycleRules: [{ maxImageCount: 2, description: "Keep only the 2 most recent images" }],
  });

  const ecsLogGroup = new logs.LogGroup(scope, "AsaEcsLogGroup", {
    logGroupName: prefixedLogGroupName(props.resourceNameSegment, "ecs/server"),
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const notificationWebhookSecret = secretsmanager.Secret.fromSecretNameV2(
    scope,
    "NotificationWebhookSecret",
    props.notificationWebhookSecretName,
  );
  const serverPasswordSecret = secretsmanager.Secret.fromSecretNameV2(scope, "ServerPasswordSecret", props.serverPasswordSecretName);
  const adminPasswordSecret = secretsmanager.Secret.fromSecretNameV2(scope, "ServerAdminPasswordSecret", props.adminPasswordSecretName);

  const taskDefinition = new ecs.FargateTaskDefinition(scope, "AsaTaskDefinition", {
    cpu: props.cpu,
    memoryLimitMiB: props.memoryMiB,
    ephemeralStorageGiB: props.ephemeralStorageGiB,
    runtimePlatform: {
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
    },
  });

  taskDefinition.addVolume({
    name: "AsaClusterData",
    efsVolumeConfiguration: {
      fileSystemId: props.clusterFileSystem.fileSystemId,
      transitEncryption: "ENABLED",
      authorizationConfig: {
        accessPointId: props.clusterAccessPoint.accessPointId,
        iam: "ENABLED",
      },
    },
  });

  const defaultMapKeys = mapStorageKeys(props.resourcePrefix, "the-island");
  const serverContainer = taskDefinition.addContainer("AsaServerContainer", {
    image: ecs.ContainerImage.fromEcrRepository(serverRepository, props.asaBuildId),
    essential: true,
    stopTimeout: cdk.Duration.seconds(props.stopTimeoutSeconds),
    healthCheck: {
      command: ["CMD-SHELL", "/asa/scripts/healthcheck.sh"],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.minutes(5),
    },
    logging: ecs.LogDrivers.awsLogs({ logGroup: ecsLogGroup, streamPrefix: "asa" }),
    portMappings: [
      { containerPort: 7777, protocol: ecs.Protocol.UDP },
      { containerPort: 7778, protocol: ecs.Protocol.UDP },
    ],
    environment: {
      AWS_REGION: props.region,
      S3_BUCKET: props.stateBucket.bucketName,
      S3_SAVE_KEY: defaultMapKeys.saveKey,
      S3_BACKUP_PREFIX: defaultMapKeys.backupPrefix,
      S3_RUNTIME_PREFIX: defaultMapKeys.runtimePrefix,
      S3_COMMON_CONFIG_PREFIX: defaultMapKeys.commonConfigPrefix,
      S3_MAP_CONFIG_PREFIX: defaultMapKeys.mapConfigPrefix,
      ASA_APP_ID: "2430930",
      ASA_INSTALL_DIR: "/asa/server",
      ASA_MAP_ID: "the-island",
      ASA_MAP: "TheIsland_WP",
      ASA_RUN_ID: "task-definition-default",
      ASA_SESSION_NAME: "private-asa",
      ASA_MAX_PLAYERS: String(DEFAULT_MAX_PLAYERS),
      ASA_PORT: "7777",
      ASA_RCON_PORT: "27020",
      ASA_CLUSTER_ID: props.asaClusterId,
      ASA_DISABLE_BATTLEYE: "true",
      ASA_UPDATE_ON_START: String(props.asaUpdateOnStart),
      AUTO_BACKUP_INTERVAL_SECONDS: "600",
      BACKUP_REQUEST_KEY: defaultMapKeys.backupRequestKey,
      HEARTBEAT_KEY: defaultMapKeys.heartbeatKey,
      READY_KEY: defaultMapKeys.readyKey,
    },
    secrets: {
      DISCORD_WEBHOOK_URL: ecs.Secret.fromSecretsManager(notificationWebhookSecret),
      ASA_SERVER_PASSWORD: ecs.Secret.fromSecretsManager(serverPasswordSecret),
      ASA_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPasswordSecret),
    },
  });
  serverContainer.addMountPoints({
    containerPath: "/asa/cluster",
    sourceVolume: "AsaClusterData",
    readOnly: false,
  });
  props.clusterFileSystem.grant(taskDefinition.taskRole, "elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite");

  const migrationTaskDefinition = new ecs.FargateTaskDefinition(scope, "AsaStorageMigrationTaskDefinition", {
    cpu: 2048,
    memoryLimitMiB: 4096,
    ephemeralStorageGiB: props.ephemeralStorageGiB,
    runtimePlatform: {
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
    },
  });
  migrationTaskDefinition.addVolume({
    name: "AsaClusterAdminData",
    efsVolumeConfiguration: {
      fileSystemId: props.clusterFileSystem.fileSystemId,
      transitEncryption: "ENABLED",
      authorizationConfig: { accessPointId: props.clusterAdminAccessPoint.accessPointId, iam: "ENABLED" },
    },
  });
  const migrationContainer = migrationTaskDefinition.addContainer("AsaServerContainer", {
    image: ecs.ContainerImage.fromEcrRepository(serverRepository, props.asaBuildId),
    essential: true,
    user: "0",
    logging: ecs.LogDrivers.awsLogs({ logGroup: ecsLogGroup, streamPrefix: "storage-migration" }),
    environment: {
      AWS_REGION: props.region,
      ASA_OPERATION_MODE: "invalid-until-overridden",
      ASA_CLUSTER_DIR: "/asa/efs-root/cluster-data",
      EFS_ADMIN_ROOT: "/asa/efs-root",
    },
  });
  migrationContainer.addMountPoints({
    containerPath: "/asa/efs-root",
    sourceVolume: "AsaClusterAdminData",
    readOnly: false,
  });
  props.clusterFileSystem.grant(
    migrationTaskDefinition.taskRole,
    "elasticfilesystem:ClientMount",
    "elasticfilesystem:ClientWrite",
    "elasticfilesystem:ClientRootAccess",
  );
  migrationTaskDefinition.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ["s3:ListBucket"], resources: [props.stateBucket.bucketArn] }),
  );
  migrationTaskDefinition.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [props.stateBucket.arnForObjects(`${props.resourcePrefix}*`)],
    }),
  );
  const migrationExecutionRole = migrationTaskDefinition.executionRole;
  if (!migrationExecutionRole) throw new Error("Migration task definition is missing an execution role.");
  serverRepository.grantPull(migrationExecutionRole);

  const executionRole = taskDefinition.executionRole;
  if (!executionRole) throw new Error("Fargate task definition is missing an execution role.");
  serverRepository.grantPull(executionRole);
  notificationWebhookSecret.grantRead(executionRole);
  serverPasswordSecret.grantRead(executionRole);
  adminPasswordSecret.grantRead(executionRole);

  taskDefinition.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [props.stateBucket.bucketArn],
      conditions: {
        StringLike: {
          "s3:prefix": [`${props.resourcePrefix}config/*`, `${props.resourcePrefix}maps/*`],
        },
      },
    }),
  );
  taskDefinition.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [
        props.stateBucket.arnForObjects(`${props.resourcePrefix}config/*`),
        props.stateBucket.arnForObjects(`${props.resourcePrefix}maps/*`),
      ],
    }),
  );
  taskDefinition.taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["s3:PutObject"],
      resources: [props.stateBucket.arnForObjects(`${props.resourcePrefix}maps/*`)],
    }),
  );

  return { cluster, serverRepository, taskDefinition, migrationTaskDefinition, executionRole };
}
