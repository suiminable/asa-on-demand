import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { ChangeResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import type { EventBridgeEvent } from "aws-lambda";
import { runtimeSecondsBetween, splitRuntimeByJstMonth } from "../../shared/budget.js";
import { getSecret, requireEnv } from "../../shared/config.js";
import { postWebhook } from "../../shared/discord.js";
import { connectCommandForIp, eniIdFromTask, taskStopReason } from "../../shared/ecs.js";
import { mapById } from "../../shared/maps.js";
import { mapDnsName, mapStorageKeys, parseTaskGroup, stopScheduleName } from "../../shared/resources.js";
import { StateStore } from "../../shared/state.js";

interface EcsTaskStateChangeDetail {
  clusterArn: string;
  taskArn: string;
  group?: string;
  version?: number;
  lastStatus: string;
  desiredStatus?: string;
  stoppedReason?: string;
  startedAt?: string;
  stoppedAt?: string;
  containers?: Array<{ name?: string; lastStatus?: string; exitCode?: number; reason?: string }>;
}

const ecs = new ECSClient({});
const ec2 = new EC2Client({});
const route53 = new Route53Client({});
const s3 = new S3Client({});
const scheduler = new SchedulerClient({});
const store = new StateStore(requireEnv("TABLE_NAME"));

const clusterArn = requireEnv("CLUSTER_ARN");
const webhookSecretName = requireEnv("NOTIFICATION_WEBHOOK_SECRET_NAME");
const bucketName = requireEnv("S3_BUCKET");
const resourcePrefix = process.env.RESOURCE_PREFIX ?? "";
const environmentName = process.env.ENVIRONMENT_NAME ?? "default";
const domainName = process.env.DOMAIN_NAME || undefined;
const hostedZoneId = process.env.HOSTED_ZONE_ID || undefined;
const hourlyCostJpy = Number(process.env.HOURLY_COST_JPY ?? "52");
const jpyPerUsd = Number(process.env.JPY_PER_USD ?? "150");

async function resolvePublicIp(taskArn: string): Promise<string | undefined> {
  const tasks = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] }));
  const task = tasks.tasks?.[0];
  if (!task) return undefined;
  const eniId = eniIdFromTask(task);
  if (!eniId) return undefined;
  const network = await ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }));
  return network.NetworkInterfaces?.[0]?.Association?.PublicIp;
}

async function updateDns(mapId: string, publicIp: string): Promise<string | undefined> {
  if (!hostedZoneId || !domainName) return undefined;
  const definition = mapById(mapId);
  if (!definition) return undefined;
  const name = mapDnsName(definition, domainName);
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: { Name: name, Type: "A", TTL: 60, ResourceRecords: [{ Value: publicIp }] },
          },
        ],
      },
    }),
  );
  return name;
}

async function deleteDns(mapId: string, publicIp: string): Promise<void> {
  if (!hostedZoneId || !domainName) return;
  const definition = mapById(mapId);
  if (!definition) return;
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "DELETE",
            ResourceRecordSet: {
              Name: mapDnsName(definition, domainName),
              Type: "A",
              TTL: 60,
              ResourceRecords: [{ Value: publicIp }],
            },
          },
        ],
      },
    }),
  );
}

function estimateCost(runtime: number): { jpy: number; usd: number } {
  const jpy = (runtime / 3600) * hourlyCostJpy;
  return { jpy, usd: jpy / jpyPerUsd };
}

async function lastBackupAt(mapId: string, runId: string): Promise<string | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: mapStorageKeys(resourcePrefix, mapId).lastBackupKey }));
    const value = JSON.parse((await object.Body?.transformToString()) ?? "{}") as { runId?: unknown; lastBackupAt?: unknown };
    return value.runId === runId && typeof value.lastBackupAt === "string" ? value.lastBackupAt : null;
  } catch {
    return null;
  }
}

export async function handler(event: EventBridgeEvent<"ECS Task State Change", EcsTaskStateChangeDetail>): Promise<void> {
  const detail = event.detail;
  if (detail.clusterArn !== clusterArn) return;
  const identity = parseTaskGroup(detail.group);
  if (!identity) {
    console.log(`Ignoring task event with unrelated group: ${detail.group ?? "missing"}`);
    return;
  }
  const definition = mapById(identity.mapId);
  if (!definition) {
    console.log(`Ignoring task event for unknown mapId: ${identity.mapId}`);
    return;
  }
  const eventVersion = Number.isInteger(detail.version) ? (detail.version as number) : 0;

  if (detail.lastStatus === "RUNNING") {
    const publicIp = await resolvePublicIp(detail.taskArn);
    const dnsName = publicIp && hostedZoneId && domainName ? mapDnsName(definition, domainName) : undefined;
    let connectCommand = connectCommandForIp(publicIp);
    const updatedState = await store.updateMapFromRunningEvent({
      mapId: identity.mapId,
      runId: identity.runId,
      taskArn: detail.taskArn,
      eventVersion,
      clusterArn: detail.clusterArn,
      taskStartedAt: detail.startedAt ?? new Date().toISOString(),
      publicIp: publicIp ?? null,
      connectCommand,
    });
    if (!updatedState) {
      console.log(`Ignoring stale RUNNING event for ${identity.mapId}/${identity.runId}`);
      return;
    }
    if (publicIp && dnsName) {
      try {
        await updateDns(identity.mapId, publicIp);
        const dnsConnectCommand = connectCommandForIp(publicIp, dnsName);
        if (
          dnsConnectCommand &&
          (await store.updateRunningConnectCommand({
            mapId: identity.mapId,
            runId: identity.runId,
            taskArn: detail.taskArn,
            eventVersion,
            connectCommand: dnsConnectCommand,
          }))
        ) {
          connectCommand = dnsConnectCommand;
        }
      } catch (error) {
        console.error(`Could not update DNS for ${identity.mapId}; keeping the direct-IP connect command.`, error);
      }
    }
    await postWebhook(
      await getSecret(webhookSecretName),
      [
        `ASA map task is running.`,
        `Map: ${definition.name}`,
        `Session: ${updatedState.sessionName}`,
        publicIp ? `Public IP: ${publicIp}` : "Public IP: not available yet",
        `Connect: ${connectCommand ?? "not available yet"}`,
        "Game server may still be loading. Wait for READY notification.",
      ].join("\n"),
    );
    return;
  }

  if (detail.lastStatus !== "STOPPED") return;
  const state = await store.getMap(identity.mapId);
  if (!state || state.runId !== identity.runId) {
    console.log(`Ignoring stale STOPPED event for ${identity.mapId}/${identity.runId}/${detail.taskArn}`);
    return;
  }
  if (!state.taskArn) {
    if (!(await store.attachStartedTask(identity.mapId, identity.runId, detail.taskArn))) {
      console.log(`Could not associate early STOPPED event for ${identity.mapId}/${identity.runId}`);
      return;
    }
    state.taskArn = detail.taskArn;
  }
  if (state.taskArn !== detail.taskArn) {
    console.log(`Ignoring STOPPED event with a mismatched task ARN for ${identity.mapId}/${identity.runId}`);
    return;
  }
  await scheduler
    .send(new DeleteScheduleCommand({ Name: stopScheduleName(environmentName, identity.mapId), GroupName: "default" }))
    .catch((error) => console.error(`Could not delete the stopped Map schedule for ${identity.mapId}.`, error));
  const stoppedAt = detail.stoppedAt ? new Date(detail.stoppedAt) : new Date();
  const startedAt = detail.startedAt ?? state.taskStartedAt ?? state.startedAt;
  const runtime = runtimeSecondsBetween(startedAt, stoppedAt);
  const budgets = splitRuntimeByJstMonth(startedAt, stoppedAt).map((slice) => {
    const estimated = estimateCost(slice.runtimeSeconds);
    return {
      budgetPk: slice.budgetPk,
      runtimeSeconds: slice.runtimeSeconds,
      estimatedCostJpy: estimated.jpy,
      estimatedCostUsd: estimated.usd,
    };
  });
  const reason = taskStopReason(detail.stoppedReason, detail.containers);
  const backupAt = await lastBackupAt(identity.mapId, identity.runId);
  const settled = await store.settleStoppedMapTask({
    mapId: identity.mapId,
    runId: identity.runId,
    taskArn: detail.taskArn,
    reservations: state.reservations,
    budgets,
    reason,
    eventVersion,
    lastBackupAt: backupAt,
  });
  if (!settled) {
    console.log(`Ignoring duplicate STOPPED event for ${identity.mapId}/${identity.runId}`);
    return;
  }
  if (state.publicIp) {
    await deleteDns(identity.mapId, state.publicIp).catch((error) =>
      console.error(`Could not delete the stopped Map DNS record for ${identity.mapId}.`, error),
    );
  }
  const unexpected = state.status !== "STOPPING" && detail.stoppedReason && !detail.stoppedReason.includes("USER_REQUEST");
  await postWebhook(
    await getSecret(webhookSecretName),
    [
      unexpected ? "ASA map stopped unexpectedly or was interrupted." : "ASA map stopped.",
      `Map: ${definition.name}`,
      `Runtime: ${Math.floor(runtime / 3600)}h ${Math.floor((runtime % 3600) / 60)}m`,
      `Last backup: ${backupAt ?? "unknown"}`,
      `Reason: ${reason}`,
    ].join("\n"),
  );
}
