import { ECSClient, StopTaskCommand } from "@aws-sdk/client-ecs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { hours, monthKey } from "../../shared/budget.js";
import { getSecret, intEnv, requireEnv } from "../../shared/config.js";
import { HEARTBEAT_FRESHNESS_SECONDS } from "../../shared/defaults.js";
import { postWebhook } from "../../shared/discord.js";
import { evaluateIdleCheck } from "../../shared/idle-check.js";
import { mapById } from "../../shared/maps.js";
import { mapStorageKeys, stopScheduleName } from "../../shared/resources.js";
import { StateStore } from "../../shared/state.js";
import type { MapServerState } from "../../shared/types.js";

type StopReason = "USER_REQUEST" | "IDLE_TIMEOUT" | "BUDGET_EXCEEDED" | "SESSION_EXPIRED";

interface StopInput {
  source: "IDLE_CHECK" | "MANUAL";
  mapId?: string;
  runId?: string;
  expectedTaskArn?: string;
  reason?: StopReason;
  requestedByDiscordUserId?: string | null;
}

const ecs = new ECSClient({});
const s3 = new S3Client({});
const scheduler = new SchedulerClient({});
const store = new StateStore(requireEnv("TABLE_NAME"));
const clusterArn = requireEnv("CLUSTER_ARN");
const webhookSecretName = requireEnv("NOTIFICATION_WEBHOOK_SECRET_NAME");
const bucketName = requireEnv("S3_BUCKET");
const resourcePrefix = process.env.RESOURCE_PREFIX ?? "";
const environmentName = process.env.ENVIRONMENT_NAME ?? "default";
const monthlyRuntimeHoursLimit = intEnv("MONTHLY_RUNTIME_HOURS_LIMIT", 80);
const heartbeatFreshnessSeconds = intEnv("HEARTBEAT_FRESHNESS_SECONDS", HEARTBEAT_FRESHNESS_SECONDS);

function matchesInput(state: MapServerState | undefined, event: StopInput): state is MapServerState {
  return Boolean(
    state?.taskArn &&
      state.mapId === event.mapId &&
      state.runId === event.runId &&
      state.taskArn === event.expectedTaskArn &&
      (state.status === "RUNNING" || state.status === "STARTING"),
  );
}

async function deleteSchedule(mapId: string): Promise<void> {
  await scheduler
    .send(new DeleteScheduleCommand({ Name: stopScheduleName(environmentName, mapId), GroupName: "default" }))
    .catch(() => undefined);
}

async function stopMap(state: MapServerState, reason: StopReason, detail?: string) {
  if (!state.taskArn || !state.runId) return { stopped: false, reason: "not running" };
  await ecs.send(new StopTaskCommand({ cluster: clusterArn, task: state.taskArn, reason }));
  const marked = await store.markMapStopping(state.mapId, state.runId, state.taskArn, reason);
  if (!marked) return { stopped: false, reason: "stale request" };
  await deleteSchedule(state.mapId);
  const definition = mapById(state.mapId);
  await postWebhook(
    await getSecret(webhookSecretName),
    [
      "ASA map is stopping.",
      `Map: ${definition?.name ?? state.mapId}`,
      `Session: ${state.sessionName}`,
      `Reason: ${reason}`,
      detail,
      "Saving world and uploading the map backup to S3...",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return { stopped: true, reason };
}

async function readHeartbeat(state: MapServerState): Promise<unknown> {
  try {
    const key = mapStorageKeys(resourcePrefix, state.mapId).heartbeatKey;
    const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const body = await object.Body?.transformToString();
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}

export async function handler(event: StopInput): Promise<{ stopped: boolean; reason: string }> {
  if (!event.mapId || !event.runId || !event.expectedTaskArn) return { stopped: false, reason: "invalid input" };
  const state = await store.getMap(event.mapId);
  if (!matchesInput(state, event)) {
    console.log(`Ignoring stale stop input for ${event.mapId}/${event.runId}/${event.expectedTaskArn}`);
    return { stopped: false, reason: "stale request" };
  }
  if (event.source !== "IDLE_CHECK") return stopMap(state, event.reason ?? "USER_REQUEST");

  const now = new Date();
  const budget = await store.getBudget(monthKey(now));
  const evaluation = { state, budget, now, monthlyRuntimeHoursLimit, heartbeatFreshnessSeconds };
  let decision = evaluateIdleCheck({ ...evaluation, heartbeat: undefined });
  if (state.status === "RUNNING" && decision.rule === "HEARTBEAT_INVALID") {
    decision = evaluateIdleCheck({ ...evaluation, heartbeat: await readHeartbeat(state) });
  }
  console.log(
    JSON.stringify({
      kind: "idle-check",
      mapId: state.mapId,
      runId: state.runId,
      status: state.status,
      heartbeatAgeSeconds: decision.heartbeatAgeSeconds,
      playerCount: decision.playerCount,
      idleMinutes: decision.idleMinutes,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      expiresAt: state.expiresAt,
      rule: decision.rule,
      action: decision.action,
    }),
  );
  if (decision.stateUpdate && state.taskArn && state.runId) {
    await store.updateRunningIdleState(state.mapId, state.runId, state.taskArn, decision.stateUpdate);
  }
  if (decision.action !== "STOP" || !decision.reason) return { stopped: false, reason: decision.rule };

  const detail =
    decision.reason === "IDLE_TIMEOUT"
      ? `Idle: ${decision.idleMinutes?.toFixed(1) ?? "unknown"}m / ${state.idleTimeoutMinutes}m`
      : decision.reason === "SESSION_EXPIRED"
        ? `Session expiry: ${state.expiresAt}`
        : `This month: ${hours(decision.currentMonthRuntimeSeconds)}h / ${monthlyRuntimeHoursLimit}h`;
  return stopMap(state, decision.reason, detail);
}
