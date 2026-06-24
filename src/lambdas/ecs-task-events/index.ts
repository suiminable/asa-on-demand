import type { EventBridgeEvent } from "aws-lambda";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { ChangeResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { monthKey } from "../../shared/budget.js";
import { getSecret, requireEnv } from "../../shared/config.js";
import { postWebhook } from "../../shared/discord.js";
import { connectCommandForIp, eniIdFromTask } from "../../shared/ecs.js";
import { StateStore } from "../../shared/state.js";

interface EcsTaskStateChangeDetail {
  clusterArn: string;
  taskArn: string;
  lastStatus: string;
  desiredStatus?: string;
  stoppedReason?: string;
  containers?: Array<{ name?: string; lastStatus?: string; exitCode?: number; reason?: string }>;
}

const ecs = new ECSClient({});
const ec2 = new EC2Client({});
const route53 = new Route53Client({});
const store = new StateStore(requireEnv("TABLE_NAME"));

const clusterArn = requireEnv("CLUSTER_ARN");
const webhookSecretName = requireEnv("NOTIFICATION_WEBHOOK_SECRET_NAME");
const domainName = process.env.DOMAIN_NAME || undefined;
const hostedZoneId = process.env.HOSTED_ZONE_ID || undefined;

async function resolvePublicIp(taskArn: string): Promise<string | undefined> {
  const tasks = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] }));
  const task = tasks.tasks?.[0];
  if (!task) return undefined;
  const eniId = eniIdFromTask(task);
  if (!eniId) return undefined;
  const network = await ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }));
  return network.NetworkInterfaces?.[0]?.Association?.PublicIp;
}

async function updateDns(publicIp: string): Promise<void> {
  if (!hostedZoneId || !domainName) return;
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: domainName,
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

function runtimeSeconds(startedAt: string | null | undefined, stoppedAt: Date): number {
  if (!startedAt) return 0;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((stoppedAt.getTime() - start) / 1000));
}

function estimateCost(runtime: number): { jpy: number; usd: number } {
  const hours = runtime / 3600;
  const jpy = hours * 18.75;
  const usd = jpy / 150;
  return { jpy, usd };
}

export async function handler(event: EventBridgeEvent<"ECS Task State Change", EcsTaskStateChangeDetail>): Promise<void> {
  const detail = event.detail;
  const webhook = await getSecret(webhookSecretName);

  if (detail.lastStatus === "RUNNING") {
    const publicIp = await resolvePublicIp(detail.taskArn);
    const connectCommand = connectCommandForIp(publicIp, domainName);
    if (publicIp) await updateDns(publicIp);
    await store.updateServerStatus("RUNNING", { publicIp: publicIp ?? null, connectCommand, taskArn: detail.taskArn, clusterArn: detail.clusterArn });
    await postWebhook(
      webhook,
      [`ASA task is running.`, publicIp ? `Public IP: ${publicIp}` : "Public IP: not available yet", `Connect: ${connectCommand ?? "not available yet"}`, "Game server may still be loading. Wait for READY notification."].join("\n"),
    );
    return;
  }

  if (detail.lastStatus === "STOPPED") {
    const now = new Date();
    const state = await store.getServer();
    const runtime = runtimeSeconds(state?.startedAt, now);
    const estimated = estimateCost(runtime);
    await store.addRuntimeToBudget(monthKey(now), runtime, estimated.jpy, estimated.usd);
    await store.updateServerStatus("STOPPED", {
      taskArn: null,
      publicIp: null,
      connectCommand: null,
      lastStopReason: detail.stoppedReason ?? "STOPPED",
    });
    const unexpected = state?.status !== "STOPPING" && detail.stoppedReason && !detail.stoppedReason.includes("USER_REQUEST");
    await postWebhook(
      webhook,
      [
        unexpected ? "ASA server stopped unexpectedly or was interrupted." : "ASA server stopped.",
        `Runtime: ${Math.floor(runtime / 3600)}h ${Math.floor((runtime % 3600) / 60)}m`,
        `Last backup: ${state?.lastBackupAt ?? "unknown"}`,
        `Reason: ${detail.stoppedReason ?? "unknown"}`,
      ].join("\n"),
    );
  }
}

