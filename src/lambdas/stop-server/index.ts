import { ECSClient, StopTaskCommand } from "@aws-sdk/client-ecs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { hours, monthKey } from "../../shared/budget.js";
import { getSecret, intEnv, requireEnv } from "../../shared/config.js";
import { HEARTBEAT_FRESHNESS_SECONDS } from "../../shared/defaults.js";
import { postWebhook } from "../../shared/discord.js";
import { evaluateIdleCheck } from "../../shared/idle-check.js";
import { StateStore } from "../../shared/state.js";
import type { ServerState } from "../../shared/types.js";

interface StopInput {
  source?: "IDLE_CHECK";
  reason?: "USER_REQUEST" | "IDLE_TIMEOUT" | "BUDGET_EXCEEDED";
  requestedByDiscordUserId?: string | null;
}

const ecs = new ECSClient({});
const s3 = new S3Client({});
const scheduler = new SchedulerClient({});
const store = new StateStore(requireEnv("TABLE_NAME"));
const clusterArn = requireEnv("CLUSTER_ARN");
const webhookSecretName = requireEnv("NOTIFICATION_WEBHOOK_SECRET_NAME");
const stopScheduleName = requireEnv("STOP_SCHEDULE_NAME");
const bucketName = requireEnv("S3_BUCKET");
const heartbeatKey = `${process.env.S3_RUNTIME_PREFIX ?? "runtime/"}heartbeat.json`;
const monthlyRuntimeHoursLimit = intEnv("MONTHLY_RUNTIME_HOURS_LIMIT", 80);
const heartbeatFreshnessSeconds = intEnv("HEARTBEAT_FRESHNESS_SECONDS", HEARTBEAT_FRESHNESS_SECONDS);

async function deleteSchedule(): Promise<void> {
  await scheduler.send(new DeleteScheduleCommand({ Name: stopScheduleName, GroupName: "default" })).catch(() => undefined);
}

async function stopServer(state: ServerState, reason: "USER_REQUEST" | "IDLE_TIMEOUT" | "BUDGET_EXCEEDED", detail?: string) {
  if (!state.taskArn) return { stopped: false, reason: "not running" };
  await ecs.send(new StopTaskCommand({ cluster: clusterArn, task: state.taskArn, reason }));
  await store.updateServerStatus("STOPPING", { lastStopReason: reason });
  await deleteSchedule();
  const webhook = await getSecret(webhookSecretName);
  await postWebhook(
    webhook,
    [`ASA server is stopping.`, `Reason: ${reason}`, detail, "Saving world and uploading backup to S3..."].filter(Boolean).join("\n"),
  );
  return { stopped: true, reason };
}

async function readHeartbeat(): Promise<unknown> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: heartbeatKey }));
    const body = await object.Body?.transformToString();
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}

export async function handler(event: StopInput): Promise<{ stopped: boolean; reason: string }> {
  const state = await store.getServer();
  if (event.source !== "IDLE_CHECK") {
    if (!state?.taskArn || (state.status !== "RUNNING" && state.status !== "STARTING")) {
      return { stopped: false, reason: "not running" };
    }
    return stopServer(state, event.reason ?? "USER_REQUEST");
  }

  const now = new Date();
  const budget = await store.getBudget(monthKey(now));
  const evaluation = {
    state,
    budget,
    now,
    monthlyRuntimeHoursLimit,
    heartbeatFreshnessSeconds,
  };
  let decision = evaluateIdleCheck({ ...evaluation, heartbeat: undefined });
  if (state?.status === "RUNNING" && decision.rule === "HEARTBEAT_INVALID") {
    decision = evaluateIdleCheck({ ...evaluation, heartbeat: await readHeartbeat() });
  }
  console.log(
    JSON.stringify({
      kind: "idle-check",
      status: state?.status ?? "MISSING",
      heartbeatAgeSeconds: decision.heartbeatAgeSeconds,
      playerCount: decision.playerCount,
      idleMinutes: decision.idleMinutes,
      idleTimeoutMinutes: state?.idleTimeoutMinutes,
      idleSince: decision.stateUpdate?.idleSince ?? state?.idleSince ?? null,
      lastHeartbeatAt: decision.stateUpdate?.lastHeartbeatAt ?? state?.lastHeartbeatAt ?? null,
      currentMonthRuntimeHours: hours(decision.currentMonthRuntimeSeconds),
      rule: decision.rule,
      action: decision.action,
    }),
  );

  if (decision.action === "DELETE_SCHEDULE") {
    await deleteSchedule();
    return { stopped: false, reason: "not running" };
  }
  if (decision.stateUpdate && state?.taskArn) {
    await store.updateRunningIdleState(state.taskArn, decision.stateUpdate);
  }
  if (decision.action !== "STOP" || !state || !decision.reason) {
    return { stopped: false, reason: decision.rule };
  }

  const detail =
    decision.reason === "IDLE_TIMEOUT"
      ? `Rule: ${decision.rule}\nIdle: ${decision.idleMinutes?.toFixed(1) ?? "unknown"}m / ${state.idleTimeoutMinutes}m`
      : `Rule: ${decision.rule}\nThis month: ${hours(decision.currentMonthRuntimeSeconds)}h / ${monthlyRuntimeHoursLimit}h`;
  return stopServer(state, decision.reason, detail);
}
