import { createHash } from "node:crypto";
import { ECSClient, RunTaskCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { canStart, currentMonthRuntimeSeconds, hours, monthKey } from "../../shared/budget.js";
import {
  getJsonArrayParameter,
  getParameter,
  getSecret,
  intEnv,
  parameterNamesFor,
  requireEnv,
  secretNamesFor,
} from "../../shared/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MAX_PLAYERS,
  HEARTBEAT_FRESHNESS_SECONDS,
  MAX_IDLE_MINUTES,
  MAX_PLAYERS,
  MIN_IDLE_MINUTES,
  STATE_SCHEMA_VERSION,
} from "../../shared/defaults.js";
import {
  type DiscordInteraction,
  deferred,
  EPHEMERAL,
  InteractionResponseType,
  InteractionType,
  isAuthorized,
  message,
  optionValue,
  postInteractionFollowup,
  postWebhook,
  subcommandName,
  userIdFromInteraction,
  verifyDiscordSignature,
} from "../../shared/discord.js";
import { eventModLabel, parseEventModId } from "../../shared/events.js";
import { parseHeartbeatJson, parseReadyJson } from "../../shared/heartbeat.js";
import {
  ASA_MAPS,
  type AsaMapDefinition,
  enabledMapDefinitions,
  isSupportedAsaMap,
  mapByArkMapName,
  parseEnabledMaps,
  sessionNameFor,
} from "../../shared/maps.js";
import { mapStorageKeys, stopScheduleName, taskGroup } from "../../shared/resources.js";
import { StateStore } from "../../shared/state.js";
import type { MapServerState, StartOperation } from "../../shared/types.js";

const ecs = new ECSClient({});
const lambda = new LambdaClient({});
const scheduler = new SchedulerClient({});
const s3 = new S3Client({});

const tableName = requireEnv("TABLE_NAME");
const clusterArn = requireEnv("CLUSTER_ARN");
const taskDefinitionArn = requireEnv("TASK_DEFINITION_ARN");
const subnetIds = requireEnv("SUBNET_IDS").split(",").filter(Boolean);
const securityGroupId = requireEnv("SECURITY_GROUP_ID");
const stopSchedulerRoleArn = requireEnv("STOP_SCHEDULER_ROLE_ARN");
const bucketName = requireEnv("S3_BUCKET");
const resourcePrefix = process.env.RESOURCE_PREFIX ?? "";
const environmentName = process.env.ENVIRONMENT_NAME ?? "default";
const parameterNames = parameterNamesFor(process.env.CONFIG_PREFIX);
const secretNames = secretNamesFor(process.env.CONFIG_PREFIX);
const defaultIdleMinutes = intEnv("DEFAULT_IDLE_MINUTES", DEFAULT_IDLE_MINUTES);
const monthlyRuntimeHoursLimit = intEnv("MONTHLY_RUNTIME_HOURS_LIMIT", 80);
const maxConcurrentMaps = intEnv("MAX_CONCURRENT_MAPS", 2);
const spotHourlyCostJpy = Number(process.env.SPOT_HOURLY_COST_JPY ?? "17");
const enableOnDemandFallback = process.env.ENABLE_ON_DEMAND_FALLBACK === "true";
const allowDiscordPasswordNotification = process.env.ALLOW_DISCORD_PASSWORD_NOTIFICATION === "true";
const functionName = requireEnv("AWS_LAMBDA_FUNCTION_NAME");
const heartbeatFreshnessSeconds = intEnv("HEARTBEAT_FRESHNESS_SECONDS", HEARTBEAT_FRESHNESS_SECONDS);

interface AsyncCommandEvent {
  source: "asa.discord.command";
  interaction: DiscordInteraction;
}

function isAsyncCommandEvent(event: APIGatewayProxyEventV2 | AsyncCommandEvent): event is AsyncCommandEvent {
  return "source" in event && event.source === "asa.discord.command";
}

const store = new StateStore(tableName);

function response(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function spotCostJpy(runtimeSeconds: number): number {
  return (runtimeSeconds / 3600) * spotHourlyCostJpy;
}

function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function runIdFor(interaction: DiscordInteraction): string {
  return createHash("sha256").update(`discord:${interaction.id}`).digest("base64url").slice(0, 32);
}

function active(state: MapServerState): boolean {
  return state.status === "STARTING" || state.status === "RUNNING" || state.status === "STOPPING";
}

async function currentRuntime(now: Date) {
  const [budget, states] = await Promise.all([
    store.getBudget(monthKey(now)),
    store.getMaps(ASA_MAPS.map((definition) => definition.mapId)),
  ]);
  const runtimeSeconds = currentMonthRuntimeSeconds({
    budget,
    activeTaskStartedAt: states.filter(active).map((state) => state.taskStartedAt ?? state.startedAt),
    now,
  });
  return { budget, runtimeSeconds };
}

async function enabledDefinitions(): Promise<AsaMapDefinition[]> {
  const enabled = parseEnabledMaps(await getParameter(parameterNames.enabledMaps, ""));
  const unsupported = enabled.filter((value) => !isSupportedAsaMap(value));
  if (unsupported.length > 0) {
    throw new Error(`The enabled-maps parameter contains unsupported map values: ${unsupported.join(", ")}.`);
  }
  return enabledMapDefinitions(enabled);
}

async function selectedDefinition(interaction: DiscordInteraction, useDefault: boolean): Promise<AsaMapDefinition | undefined> {
  let arkMapName = optionValue<string>(interaction, "map");
  if (!arkMapName && useDefault) arkMapName = await getParameter(parameterNames.defaultMap, "TheIsland_WP");
  if (!arkMapName) return undefined;
  const definition = mapByArkMapName(arkMapName);
  if (!definition) throw new Error(`Unsupported map: ${arkMapName}. Re-register the Discord commands.`);
  const enabled = await enabledDefinitions();
  if (!enabled.some((value) => value.mapId === definition.mapId)) {
    throw new Error(`Map ${arkMapName} is not enabled. Enabled maps: ${enabled.map((value) => value.arkMapName).join(", ")}.`);
  }
  return definition;
}

async function targetState(interaction: DiscordInteraction): Promise<{ definition: AsaMapDefinition; state: MapServerState } | string> {
  const selected = await selectedDefinition(interaction, false);
  const definitions = await enabledDefinitions();
  if (selected) {
    const state = await store.getMap(selected.mapId);
    return state && active(state) ? { definition: selected, state } : `${selected.name} is not running.`;
  }
  const states = await store.getMaps(definitions.map((value) => value.mapId));
  const running = states.filter(active);
  if (running.length === 0) return "No ASA map is running.";
  if (running.length > 1) return `Multiple maps are active (${running.map((value) => value.mapId).join(", ")}); specify map.`;
  const definition = definitions.find((value) => value.mapId === running[0].mapId);
  if (!definition) return "The active map is not in the enabled map registry.";
  return { definition, state: running[0] };
}

async function createStopSchedule(state: MapServerState): Promise<void> {
  const name = stopScheduleName(environmentName, state.mapId);
  await scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: "default" })).catch(() => undefined);
  await scheduler.send(
    new CreateScheduleCommand({
      Name: name,
      GroupName: "default",
      FlexibleTimeWindow: { Mode: "OFF" },
      ScheduleExpression: "rate(1 minute)",
      Target: {
        Arn: requireEnv("STOP_SERVER_FUNCTION_ARN"),
        RoleArn: stopSchedulerRoleArn,
        Input: JSON.stringify({
          source: "IDLE_CHECK",
          mapId: state.mapId,
          runId: state.runId,
          expectedTaskArn: state.taskArn,
        }),
      },
    }),
  );
}

async function handleStart(interaction: DiscordInteraction) {
  const now = new Date();
  const idleTimeoutMinutes = Number(optionValue<number>(interaction, "idle_minutes") ?? defaultIdleMinutes);
  let maxPlayers = Math.min(Math.max(Number(optionValue<number>(interaction, "max_players") ?? DEFAULT_MAX_PLAYERS), 1), MAX_PLAYERS);
  const publicNotify = optionValue<boolean>(interaction, "public_notify") ?? true;
  if (!Number.isInteger(idleTimeoutMinutes) || idleTimeoutMinutes < MIN_IDLE_MINUTES || idleTimeoutMinutes > MAX_IDLE_MINUTES) {
    return message(`idle_minutes must be an integer from ${MIN_IDLE_MINUTES} to ${MAX_IDLE_MINUTES}.`, true);
  }
  let definition: AsaMapDefinition;
  try {
    const selected = await selectedDefinition(interaction, true);
    if (!selected) throw new Error("A default map is required.");
    definition = selected;
  } catch (error) {
    return message(error instanceof Error ? error.message : String(error), true);
  }

  const baseSessionName = await getParameter(parameterNames.sessionName, "private-asa");
  let sessionName: string;
  try {
    sessionName = sessionNameFor(baseSessionName, definition);
  } catch (error) {
    return message(error instanceof Error ? error.message : String(error), true);
  }
  let eventModId: string | null;
  try {
    eventModId = parseEventModId(await getParameter(parameterNames.eventModId, "", { cache: false }));
  } catch (error) {
    return message(`Configured event-mod-id is invalid: ${error instanceof Error ? error.message : String(error)}.`, true);
  }
  const configuredMaxPlayers = Number(await getParameter(parameterNames.maxPlayers, String(DEFAULT_MAX_PLAYERS)));
  if (!optionValue<number>(interaction, "max_players") && Number.isFinite(configuredMaxPlayers)) {
    maxPlayers = Math.min(Math.max(configuredMaxPlayers, 1), MAX_PLAYERS);
  }

  const { runtimeSeconds } = await currentRuntime(now);
  const budgetDecision = canStart({ currentMonthRuntimeSeconds: runtimeSeconds, monthlyRuntimeHoursLimit });
  if (!budgetDecision.ok) return message(budgetDecision.reason, true);

  const runId = runIdFor(interaction);
  const userId = userIdFromInteraction(interaction) ?? null;
  const state: MapServerState = {
    pk: `MAP#${definition.mapId}`,
    mapId: definition.mapId,
    arkMapName: definition.arkMapName,
    status: "STARTING",
    runId,
    taskArn: null,
    clusterArn,
    startedAt: now.toISOString(),
    taskStartedAt: null,
    publicIp: null,
    connectCommand: null,
    sessionName,
    eventModId,
    maxPlayers,
    idleTimeoutMinutes,
    idleSince: null,
    lastHeartbeatAt: null,
    startedByDiscordUserId: userId,
    startedFromChannelId: interaction.channel_id ?? null,
    readyAt: null,
    lastBackupAt: null,
    lastStopReason: null,
    lastEcsEventVersion: null,
    updatedAt: now.toISOString(),
  };
  const operation: StartOperation = {
    pk: `OPERATION#${runId}`,
    runId,
    mapId: definition.mapId,
    phase: "CLAIMED",
    taskArn: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + 7 * 24 * 3600,
  };
  const claimed = await store.claimMapStart({
    state,
    operation,
    maxConcurrentMaps,
    budgetPk: monthKey(now),
    schemaVersion: STATE_SCHEMA_VERSION,
  });
  if (!claimed) {
    return message(`Cannot start ${definition.name}: it is already active or concurrency is full.`, true);
  }

  const keys = mapStorageKeys(resourcePrefix, definition.mapId);
  let taskArn: string;
  try {
    const runTask = await ecs.send(
      new RunTaskCommand({
        cluster: clusterArn,
        taskDefinition: taskDefinitionArn,
        platformVersion: "LATEST",
        clientToken: runId,
        startedBy: runId,
        group: taskGroup(definition.mapId, runId),
        enableECSManagedTags: true,
        propagateTags: "TASK_DEFINITION",
        tags: [
          { key: "asa:map-id", value: definition.mapId },
          { key: "asa:run-id", value: runId },
        ],
        capacityProviderStrategy: enableOnDemandFallback
          ? [
              { capacityProvider: "FARGATE_SPOT", weight: 1, base: 0 },
              { capacityProvider: "FARGATE", weight: 1, base: 0 },
            ]
          : [{ capacityProvider: "FARGATE_SPOT", weight: 1, base: 0 }],
        networkConfiguration: {
          awsvpcConfiguration: { assignPublicIp: "ENABLED", subnets: subnetIds, securityGroups: [securityGroupId] },
        },
        overrides: {
          containerOverrides: [
            {
              name: "AsaServerContainer",
              environment: [
                { name: "ASA_MAP_ID", value: definition.mapId },
                { name: "ASA_MAP", value: definition.arkMapName },
                { name: "ASA_SESSION_NAME", value: sessionName },
                { name: "ASA_RUN_ID", value: runId },
                { name: "ASA_MAX_PLAYERS", value: String(maxPlayers) },
                ...(eventModId ? [{ name: "ASA_EVENT_MOD_ID", value: eventModId }] : []),
                { name: "IDLE_TIMEOUT_MINUTES", value: String(idleTimeoutMinutes) },
                { name: "MONTHLY_RUNTIME_HOURS_LIMIT", value: String(monthlyRuntimeHoursLimit) },
                { name: "S3_SAVE_KEY", value: keys.saveKey },
                { name: "S3_BACKUP_PREFIX", value: keys.backupPrefix },
                { name: "S3_RUNTIME_PREFIX", value: keys.runtimePrefix },
                { name: "S3_COMMON_CONFIG_PREFIX", value: keys.commonConfigPrefix },
                { name: "S3_MAP_CONFIG_PREFIX", value: keys.mapConfigPrefix },
                { name: "BACKUP_REQUEST_KEY", value: keys.backupRequestKey },
                { name: "HEARTBEAT_KEY", value: keys.heartbeatKey },
                { name: "READY_KEY", value: keys.readyKey },
              ],
            },
          ],
        },
      }),
    );
    const failure = runTask.failures?.[0];
    if (failure) throw new Error(`${failure.arn ?? "RunTask"}: ${failure.reason ?? "unknown failure"}`);
    const startedTaskArn = runTask.tasks?.[0]?.taskArn;
    if (!startedTaskArn) throw new Error("RunTask returned no taskArn.");
    taskArn = startedTaskArn;
  } catch (error) {
    await store.rollbackMapStart(definition.mapId, runId, error instanceof Error ? error.message : String(error));
    throw error;
  }

  state.taskArn = taskArn;
  try {
    if (!(await store.attachStartedTask(definition.mapId, runId, taskArn)))
      throw new Error("Start claim no longer matches the current map state.");
    await createStopSchedule(state);
    if (!(await store.markOperationScheduled(runId, definition.mapId, taskArn))) throw new Error("Could not finalize start operation.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const stopRequested = await ecs
      .send(new StopTaskCommand({ cluster: clusterArn, task: taskArn, reason: "START_ROLLBACK" }))
      .then(() => true)
      .catch((stopError) => {
        console.error(`Could not stop task ${taskArn} after start finalization failed; the reconciler will recover it.`, stopError);
        return false;
      });
    if (stopRequested) await store.markMapStopping(definition.mapId, runId, taskArn, `START_FINALIZATION_FAILED: ${reason}`);
    throw error;
  }

  if (publicNotify) {
    try {
      await postWebhook(
        await getSecret(secretNames.notificationWebhookUrl),
        `ASA map start requested by <@${userId ?? "unknown"}>.\nMap: ${definition.name}\nSession: ${sessionName}\nEvent: ${eventModLabel(eventModId)}\nIdle auto-stop: ${idleTimeoutMinutes}m\nStatus: STARTING`,
      );
    } catch (error) {
      console.error("Failed to post start notification", error);
    }
  }
  return message(
    `ASA start requested.\nMap: ${definition.name}\nSession: ${sessionName}\nEvent: ${eventModLabel(eventModId)}\nIdle auto-stop: ${idleTimeoutMinutes}m`,
    true,
  );
}

async function handleStop(interaction: DiscordInteraction) {
  const target = await targetState(interaction);
  if (typeof target === "string") return message(target, true);
  await lambda.send(
    new InvokeCommand({
      FunctionName: requireEnv("STOP_SERVER_FUNCTION_ARN"),
      InvocationType: "RequestResponse",
      Payload: Buffer.from(
        JSON.stringify({
          source: "MANUAL",
          mapId: target.definition.mapId,
          runId: target.state.runId,
          expectedTaskArn: target.state.taskArn,
          reason: "USER_REQUEST",
          requestedByDiscordUserId: userIdFromInteraction(interaction) ?? null,
        }),
      ),
    }),
  );
  return message(`ASA stop requested for ${target.definition.name}.`, true);
}

async function readPlayerCount(state: MapServerState): Promise<number | undefined> {
  if (state.status !== "RUNNING" || !state.runId) return undefined;
  try {
    const key = mapStorageKeys(resourcePrefix, state.mapId).heartbeatKey;
    const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return parseHeartbeatJson(await object.Body?.transformToString(), {
      now: new Date(),
      startedAt: state.startedAt,
      freshnessSeconds: heartbeatFreshnessSeconds,
      runId: state.runId,
      mapId: state.mapId,
    })?.playerCount;
  } catch {
    return undefined;
  }
}

async function readReadyAt(state: MapServerState): Promise<string | undefined> {
  if ((state.status !== "RUNNING" && state.status !== "STARTING") || !state.runId) return undefined;
  try {
    const key = mapStorageKeys(resourcePrefix, state.mapId).readyKey;
    const object = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    return parseReadyJson(await object.Body?.transformToString(), {
      now: new Date(),
      startedAt: state.startedAt,
      runId: state.runId,
      mapId: state.mapId,
    })?.readyAt;
  } catch {
    return undefined;
  }
}

function stateLine(state: MapServerState, playerCount?: number, readyAt?: string): string {
  return `${state.mapId}: ${state.status} | ready ${readyAt ? "yes" : "no"} | players ${playerCount ?? "?"}/${state.maxPlayers} | idle ${state.idleTimeoutMinutes}m | ${state.connectCommand ?? "no address"}`;
}

async function handleStatus(interaction: DiscordInteraction) {
  const selected = await selectedDefinition(interaction, false);
  if (selected) {
    const state = await store.getMap(selected.mapId);
    if (!state) return message(`${selected.name}: STOPPED`, true);
    const [playerCount, readyAt] = await Promise.all([readPlayerCount(state), readReadyAt(state)]);
    return message(
      [
        `Status: ${state.status}`,
        `Map: ${selected.name}`,
        `Session: ${state.sessionName}`,
        `Ready: ${readyAt ?? "not ready"}`,
        `Players: ${playerCount ?? "unknown"} / ${state.maxPlayers}`,
        `Started: ${state.startedAt ?? "N/A"}`,
        `Idle auto-stop: ${state.idleTimeoutMinutes} minutes`,
        `Connect: ${state.connectCommand ?? "not available"}`,
      ].join("\n"),
      true,
    );
  }
  const definitions = await enabledDefinitions();
  const states = await store.getMaps(definitions.map((value) => value.mapId));
  const byId = new Map(states.map((state) => [state.mapId, state]));
  const lines = await Promise.all(
    definitions.map(async (definition) => {
      const state = byId.get(definition.mapId);
      if (!state) return `${definition.mapId}: STOPPED`;
      const [playerCount, readyAt] = await Promise.all([readPlayerCount(state), readReadyAt(state)]);
      return stateLine(state, playerCount, readyAt);
    }),
  );
  return message(lines.join("\n"), true);
}

async function handleInfo(interaction: DiscordInteraction) {
  const target = await targetState(interaction);
  if (typeof target === "string") return message(target, true);
  const readyAt = await readReadyAt(target.state);
  const passwordLine = allowDiscordPasswordNotification ? `Password: ${await getSecret(secretNames.serverPassword)}` : "Password: hidden";
  return message(
    [
      `Server: ${target.state.sessionName}`,
      `Map: ${target.definition.name}`,
      `Event: ${eventModLabel(target.state.eventModId)}`,
      `Ready: ${readyAt ?? "not ready"}`,
      `Connect: ${target.state.connectCommand ?? "not available"}`,
      passwordLine,
    ].join("\n"),
    true,
  );
}

async function handleBackup(interaction: DiscordInteraction) {
  const target = await targetState(interaction);
  if (typeof target === "string") return message(target, true);
  if (target.state.status !== "RUNNING" || !target.state.runId) {
    return message(`${target.definition.name} is not running. Last backup: ${target.state.lastBackupAt ?? "unknown"}`, true);
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: mapStorageKeys(resourcePrefix, target.definition.mapId).backupRequestKey,
      Body: JSON.stringify({ requestedAt: new Date().toISOString(), runId: target.state.runId }),
      ContentType: "application/json",
    }),
  );
  return message(`Backup requested for ${target.definition.name}.`, true);
}

async function handleBudget() {
  const now = new Date();
  const [{ budget, runtimeSeconds }, cluster] = await Promise.all([currentRuntime(now), store.getCluster()]);
  const settledRuntime = budget?.runtimeSeconds ?? 0;
  return message(
    [
      `Starts: ${budget?.startCount ?? 0}`,
      `Settled runtime: ${hours(settledRuntime)}h`,
      `Current runtime: ${hours(runtimeSeconds)}h / ${monthlyRuntimeHoursLimit}h`,
      `Active maps: ${cluster?.activeCount ?? 0} / ${cluster?.maxConcurrentMaps ?? maxConcurrentMaps}`,
      `Estimated cost (conservative): ¥${Math.round(budget?.estimatedCostJpy ?? 0)}`,
      `Estimated cost (Fargate Spot approx.): ¥${Math.round(spotCostJpy(runtimeSeconds))}`,
    ].join("\n"),
    true,
  );
}

async function routeCommand(interaction: DiscordInteraction) {
  try {
    switch (subcommandName(interaction)) {
      case "start":
        return await handleStart(interaction);
      case "stop":
        return await handleStop(interaction);
      case "status":
        return await handleStatus(interaction);
      case "info":
        return await handleInfo(interaction);
      case "backup":
        return await handleBackup(interaction);
      case "budget":
        return await handleBudget();
      default:
        return message("Unknown ASA command.", true);
    }
  } catch (error) {
    return message(`Command failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function handleAsyncCommand(event: AsyncCommandEvent): Promise<void> {
  const result = await routeCommand(event.interaction);
  await postInteractionFollowup(event.interaction, result.data.content, result.data.flags === EPHEMERAL);
}

export async function handler(event: APIGatewayProxyEventV2 | AsyncCommandEvent): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (isAsyncCommandEvent(event)) {
    await handleAsyncCommand(event);
    return undefined;
  }
  const body = rawBody(event);
  const [publicKey, guildId, allowedUsers, allowedRoles] = await Promise.all([
    getParameter(parameterNames.discordPublicKey),
    getParameter(parameterNames.discordGuildId),
    getJsonArrayParameter(parameterNames.allowedUserIds),
    getJsonArrayParameter(parameterNames.allowedRoleIds),
  ]);
  const signatureOk = verifyDiscordSignature({
    publicKey,
    signature: event.headers["x-signature-ed25519"] ?? event.headers["X-Signature-Ed25519"],
    timestamp: event.headers["x-signature-timestamp"] ?? event.headers["X-Signature-Timestamp"],
    rawBody: body,
  });
  if (!signatureOk) return response(401, { error: "invalid request signature" });
  const interaction = JSON.parse(body) as DiscordInteraction;
  if (interaction.type === InteractionType.Ping) return response(200, { type: InteractionResponseType.Pong });
  if (interaction.guild_id !== guildId) return response(200, message("This command is not available in this guild.", true));
  if (!isAuthorized(interaction, allowedUsers, allowedRoles)) {
    return response(200, message("You are not allowed to operate the ASA server.", true));
  }
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ source: "asa.discord.command", interaction } satisfies AsyncCommandEvent)),
      }),
    );
    return response(200, deferred(true));
  } catch (error) {
    console.error(error);
    return response(200, message(`Command failed: ${error instanceof Error ? error.message : String(error)}`, true));
  }
}
