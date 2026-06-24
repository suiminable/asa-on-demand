import type { ScheduledEvent } from "aws-lambda";
import { StopTaskCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { getSecret, requireEnv } from "../../shared/config.js";
import { postWebhook } from "../../shared/discord.js";
import { StateStore } from "../../shared/state.js";

interface StopInput {
  reason?: "USER_REQUEST" | "TTL_EXPIRED" | "BUDGET_EXCEEDED";
  requestedByDiscordUserId?: string | null;
}

const ecs = new ECSClient({});
const scheduler = new SchedulerClient({});
const store = new StateStore(requireEnv("TABLE_NAME"));
const clusterArn = requireEnv("CLUSTER_ARN");
const webhookSecretName = requireEnv("NOTIFICATION_WEBHOOK_SECRET_NAME");
const stopScheduleName = requireEnv("STOP_SCHEDULE_NAME");

export async function handler(event: ScheduledEvent | StopInput): Promise<{ stopped: boolean; reason: string }> {
  const input = event as StopInput;
  const reason = input.reason ?? "TTL_EXPIRED";
  const state = await store.getServer();
  if (!state?.taskArn || (state.status !== "RUNNING" && state.status !== "STARTING")) {
    return { stopped: false, reason: "not running" };
  }

  await ecs.send(new StopTaskCommand({ cluster: clusterArn, task: state.taskArn, reason }));
  await store.updateServerStatus("STOPPING", { lastStopReason: reason });
  await scheduler.send(new DeleteScheduleCommand({ Name: stopScheduleName, GroupName: "default" })).catch(() => undefined);
  const webhook = await getSecret(webhookSecretName);
  await postWebhook(webhook, `ASA server is stopping.\nReason: ${reason}\nSaving world and uploading backup to S3...`);
  return { stopped: true, reason };
}
