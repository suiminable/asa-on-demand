import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { normalizeConfigPrefix, parameterNamesFor, secretNamesFor } from "../shared/config.js";
import { DEFAULT_IDLE_MINUTES, HEARTBEAT_FRESHNESS_SECONDS, MAX_IDLE_MINUTES, MIN_IDLE_MINUTES } from "../shared/defaults.js";
import { createAsaCompute } from "./asa-compute.js";
import { createAsaControlPlane } from "./asa-control-plane.js";
import { createAsaNetwork } from "./asa-network.js";
import { createAsaStorage } from "./asa-storage.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "../..");

interface NumberContext {
  name: string;
  defaultValue: number;
}

function numberContext(scope: Construct, props: NumberContext): number {
  const value = scope.node.tryGetContext(props.name);
  if (value === undefined || value === null || value === "") return props.defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Context ${props.name} must be a number.`);
  return parsed;
}

function booleanContext(scope: Construct, name: string, defaultValue: boolean): boolean {
  const value = scope.node.tryGetContext(name);
  if (value === undefined || value === null || value === "") return defaultValue;
  return value === true || value === "true";
}

function stringContext(scope: Construct, name: string, defaultValue = ""): string {
  const value = scope.node.tryGetContext(name);
  if (value === undefined || value === null) return defaultValue;
  return String(value);
}

function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (!/^[A-Za-z0-9_./-]+$/.test(trimmed)) {
    throw new Error("Context resourcePrefix must contain only letters, numbers, slash, dot, underscore, or hyphen.");
  }
  return `${trimmed}/`;
}

function normalizeNameSegment(value: string, fallback = "default"): string {
  // Keep the ECR repository name derivation in sync with scripts/push-image.sh.
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

export class AsaFargateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = this.node.tryGetContext("region") ?? cdk.Stack.of(this).region;
    const resourcePrefix = normalizeS3Prefix(stringContext(this, "resourcePrefix"));
    const resourceNameSegment = resourcePrefix ? normalizeNameSegment(resourcePrefix) : "";
    const environmentId = resourcePrefix || "default";
    const environmentHash = createHash("sha256").update(environmentId).digest("hex").slice(0, 8);
    const discordFunctionName = `asa-${(resourceNameSegment || "default").slice(0, 42)}-discord-${environmentHash}`;
    const configPrefix = normalizeConfigPrefix(resourcePrefix ? `/asa/${resourcePrefix}` : "/asa");
    const parameterNames = parameterNamesFor(configPrefix);
    const secretNames = secretNamesFor(configPrefix);
    const cpu = numberContext(this, { name: "asaCpu", defaultValue: 4096 });
    const memoryMiB = numberContext(this, { name: "asaMemoryMiB", defaultValue: 24576 });
    const ephemeralStorageGiB = numberContext(this, { name: "asaEphemeralStorageGiB", defaultValue: 100 });
    const stopTimeoutSeconds = numberContext(this, { name: "asaStopTimeoutSeconds", defaultValue: 120 });
    const defaultIdleMinutes = numberContext(this, { name: "defaultIdleMinutes", defaultValue: DEFAULT_IDLE_MINUTES });
    if (!Number.isInteger(defaultIdleMinutes) || defaultIdleMinutes < MIN_IDLE_MINUTES || defaultIdleMinutes > MAX_IDLE_MINUTES) {
      throw new Error(`Context defaultIdleMinutes must be an integer from ${MIN_IDLE_MINUTES} to ${MAX_IDLE_MINUTES}.`);
    }
    const monthlyBudgetJpy = numberContext(this, { name: "monthlyBudgetJpy", defaultValue: 1500 });
    const hourlyCostJpy = numberContext(this, { name: "hourlyCostJpy", defaultValue: 52 });
    const spotHourlyCostJpy = numberContext(this, { name: "spotHourlyCostJpy", defaultValue: 17 });
    const jpyPerUsd = numberContext(this, { name: "jpyPerUsd", defaultValue: 150 });
    const monthlyRuntimeHoursLimit = numberContext(this, { name: "monthlyRuntimeHoursLimit", defaultValue: 80 });
    const configuredMaxConcurrentMaps = numberContext(this, { name: "maxConcurrentMaps", defaultValue: 2 });
    if (!Number.isInteger(configuredMaxConcurrentMaps) || configuredMaxConcurrentMaps < 1 || configuredMaxConcurrentMaps > 10) {
      throw new Error("Context maxConcurrentMaps must be an integer from 1 to 10.");
    }
    const enableParallelMapTransfer = booleanContext(this, "enableParallelMapTransfer", false);
    const maxConcurrentMaps = enableParallelMapTransfer ? configuredMaxConcurrentMaps : 1;
    const clusterBackupRetentionDays = numberContext(this, { name: "clusterBackupRetentionDays", defaultValue: 35 });
    if (!Number.isInteger(clusterBackupRetentionDays) || clusterBackupRetentionDays < 7) {
      throw new Error("Context clusterBackupRetentionDays must be an integer of at least 7.");
    }
    const enableOnDemandFallback = booleanContext(this, "enableOnDemandFallback", false);
    const allowDiscordPasswordNotification = booleanContext(this, "allowDiscordPasswordNotification", false);
    const asaBuildId = stringContext(this, "asaBuildId") || "initial";
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(asaBuildId)) {
      throw new Error("Context asaBuildId must be a valid ECR image tag.");
    }
    const asaUpdateOnStart = booleanContext(this, "asaUpdateOnStart", false);
    const asaClusterId = stringContext(this, "asaClusterId") || resourceNameSegment || "asa-on-demand";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(asaClusterId)) {
      throw new Error("Context asaClusterId must contain only letters, numbers, dot, underscore, or hyphen.");
    }
    const enableAwsBudget = booleanContext(this, "enableAwsBudget", false);
    const budgetEmail = this.node.tryGetContext("budgetEmail") as string | undefined;
    const hostedZoneId = this.node.tryGetContext("hostedZoneId") as string | undefined;
    const hostedZoneName = this.node.tryGetContext("hostedZoneName") as string | undefined;
    const domainName = this.node.tryGetContext("domainName") as string | undefined;
    if (Boolean(hostedZoneId) !== Boolean(domainName)) {
      throw new Error("Contexts hostedZoneId and domainName must be configured together.");
    }
    if (hostedZoneId && !hostedZoneName) throw new Error("hostedZoneName context is required with hostedZoneId and domainName.");
    const { vpc, serverSecurityGroup, efsSecurityGroup } = createAsaNetwork(this);
    const { clusterFileSystem, clusterAccessPoint, clusterAdminAccessPoint, stateBucket } = createAsaStorage(this, {
      vpc,
      efsSecurityGroup,
      resourcePrefix,
      clusterBackupRetentionDays,
    });
    const { cluster, serverRepository, taskDefinition, migrationTaskDefinition, executionRole } = createAsaCompute(this, {
      vpc,
      clusterFileSystem,
      clusterAccessPoint,
      clusterAdminAccessPoint,
      stateBucket,
      resourcePrefix,
      resourceNameSegment,
      region,
      cpu,
      memoryMiB,
      ephemeralStorageGiB,
      stopTimeoutSeconds,
      asaBuildId,
      asaUpdateOnStart,
      asaClusterId,
      notificationWebhookSecretName: secretNames.notificationWebhookUrl,
      serverPasswordSecretName: secretNames.serverPassword,
      adminPasswordSecretName: secretNames.serverAdminPassword,
    });

    const { api, stateTable } = createAsaControlPlane(this, {
      rootDir,
      vpc,
      serverSecurityGroup,
      stateBucket,
      cluster,
      taskDefinition,
      executionRole,
      resourcePrefix,
      resourceNameSegment,
      discordFunctionName,
      configPrefix,
      parameterNames,
      secretNames,
      defaultIdleMinutes,
      heartbeatFreshnessSeconds: HEARTBEAT_FRESHNESS_SECONDS,
      monthlyRuntimeHoursLimit,
      maxConcurrentMaps,
      monthlyBudgetJpy,
      hourlyCostJpy,
      spotHourlyCostJpy,
      jpyPerUsd,
      enableOnDemandFallback,
      allowDiscordPasswordNotification,
      hostedZoneId,
      hostedZoneName,
      domainName,
      enableAwsBudget,
      budgetEmail,
    });

    new cdk.CfnOutput(this, "DiscordInteractionsEndpointUrl", {
      value: `${api.apiEndpoint}/discord/interactions`,
    });
    new cdk.CfnOutput(this, "AsaStateBucketName", { value: stateBucket.bucketName });
    new cdk.CfnOutput(this, "AsaClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "AsaClusterArn", { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "AsaTaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "AsaMigrationTaskDefinitionArn", { value: migrationTaskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "AsaSecurityGroupId", { value: serverSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, "AsaPublicSubnetIds", { value: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(",") });
    new cdk.CfnOutput(this, "AsaResourcePrefix", { value: resourcePrefix || "/" });
    new cdk.CfnOutput(this, "AsaStateTableName", { value: stateTable.tableName });
    new cdk.CfnOutput(this, "AsaEcrRepositoryUri", { value: serverRepository.repositoryUri });
    new cdk.CfnOutput(this, "AsaClusterFileSystemId", { value: clusterFileSystem.fileSystemId });
    new cdk.CfnOutput(this, "AsaClusterAccessPointId", { value: clusterAccessPoint.accessPointId });
    new cdk.CfnOutput(this, "AsaClusterAdminAccessPointId", { value: clusterAdminAccessPoint.accessPointId });
    new cdk.CfnOutput(this, "AsaClusterId", { value: asaClusterId });
    new cdk.CfnOutput(this, "AsaStateSchemaVersion", { value: "2" });
    new cdk.CfnOutput(this, "AsaMapDnsPattern", { value: hostedZoneId && domainName ? `<mapId>.${domainName}` : "disabled" });
    if (domainName) new cdk.CfnOutput(this, "OptionalDomainName", { value: domainName });
  }
}
