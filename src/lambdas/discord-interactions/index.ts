import { ECSClient, RunTaskCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { canStart, hours, monthKey } from "../../shared/budget.js";
import {
  getJsonArrayParameter,
  getParameter,
  getSecret,
  intEnv,
  parameterNamesFor,
  requireEnv,
  secretNamesFor,
} from "../../shared/config.js";
import { DEFAULT_MAX_PLAYERS, DEFAULT_SESSION_HOURS, MAX_PLAYERS, MAX_SESSION_HOURS } from "../../shared/defaults.js";
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
import { isSupportedAsaMap, parseEnabledMaps } from "../../shared/maps.js";
import { StateStore } from "../../shared/state.js";
import type { ServerState } from "../../shared/types.js";

const ecs = new ECSClient({});
const lambda = new LambdaClient({});
const scheduler = new SchedulerClient({});
const s3 = new S3Client({});

const tableName = requireEnv("TABLE_NAME");
const clusterArn = requireEnv("CLUSTER_ARN");
const taskDefinitionArn = requireEnv("TASK_DEFINITION_ARN");
const subnetIds = requireEnv("SUBNET_IDS").split(",").filter(Boolean);
const securityGroupId = requireEnv("SECURITY_GROUP_ID");
const stopScheduleName = requireEnv("STOP_SCHEDULE_NAME");
const stopSchedulerRoleArn = requireEnv("STOP_SCHEDULER_ROLE_ARN");
const bucketName = requireEnv("S3_BUCKET");
const s3RuntimePrefix = process.env.S3_RUNTIME_PREFIX ?? "runtime/";
const parameterNames = parameterNamesFor(process.env.CONFIG_PREFIX);
const secretNames = secretNamesFor(process.env.CONFIG_PREFIX);
const maxSessionHours = intEnv("MAX_SESSION_HOURS", MAX_SESSION_HOURS);
const defaultSessionHours = intEnv("DEFAULT_SESSION_HOURS", DEFAULT_SESSION_HOURS);
const monthlyRuntimeHoursLimit = intEnv("MONTHLY_RUNTIME_HOURS_LIMIT", 80);
const spotHourlyCostJpy = Number(process.env.SPOT_HOURLY_COST_JPY ?? "17");
const enableOnDemandFallback = process.env.ENABLE_ON_DEMAND_FALLBACK === "true";
const allowDiscordPasswordNotification = process.env.ALLOW_DISCORD_PASSWORD_NOTIFICATION === "true";
const functionName = requireEnv("AWS_LAMBDA_FUNCTION_NAME");
const startingStaleMs = 10 * 60 * 1000;

interface AsyncCommandEvent {
  source: "asa.discord.command";
  interaction: DiscordInteraction;
}

function isAsyncCommandEvent(event: APIGatewayProxyEventV2 | AsyncCommandEvent): event is AsyncCommandEvent {
  return "source" in event && event.source === "asa.discord.command";
}

function isStaleStarting(state: ServerState | undefined, now: Date): boolean {
  if (state?.status !== "STARTING" || state.taskArn) return false;
  const updatedAt = Date.parse(state.updatedAt);
  return Number.isFinite(updatedAt) && now.getTime() - updatedAt >= startingStaleMs;
}

const store = new StateStore(tableName);

function response(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function spotCostJpy(runtimeSeconds: number): number {
  return (runtimeSeconds / 3600) * spotHourlyCostJpy;
}

function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function startOptions(interaction: DiscordInteraction) {
  const durationHours = Math.min(
    Math.max(Number(optionValue<number>(interaction, "duration_hours") ?? defaultSessionHours), 1),
    maxSessionHours,
  );
  const map = optionValue<string>(interaction, "map") ?? "TheIsland_WP";
  const maxPlayers = Math.min(Math.max(Number(optionValue<number>(interaction, "max_players") ?? DEFAULT_MAX_PLAYERS), 1), MAX_PLAYERS);
  const publicNotify = optionValue<boolean>(interaction, "public_notify") ?? true;
  return { durationHours, map, maxPlayers, publicNotify };
}

async function createStopSchedule(expiresAt: Date): Promise<void> {
  await scheduler
    .send(
      new DeleteScheduleCommand({
        Name: stopScheduleName,
        GroupName: "default",
      }),
    )
    .catch(() => undefined);
  await scheduler.send(
    new CreateScheduleCommand({
      Name: stopScheduleName,
      GroupName: "default",
      FlexibleTimeWindow: { Mode: "OFF" },
      ScheduleExpression: `at(${expiresAt.toISOString().replace(/\.\d{3}Z$/, "")})`,
      Target: {
        Arn: requireEnv("STOP_SERVER_FUNCTION_ARN"),
        RoleArn: stopSchedulerRoleArn,
        Input: JSON.stringify({ reason: "TTL_EXPIRED", requestedByDiscordUserId: null }),
      },
      ActionAfterCompletion: "DELETE",
    }),
  );
}

async function deleteStopSchedule(): Promise<void> {
  await scheduler.send(new DeleteScheduleCommand({ Name: stopScheduleName, GroupName: "default" })).catch(() => undefined);
}

async function handleStart(interaction: DiscordInteraction) {
  const now = new Date();
  const options = startOptions(interaction);
  const defaultMap = await getParameter(parameterNames.defaultMap, "TheIsland_WP");
  if (!optionValue<string>(interaction, "map")) options.map = defaultMap;
  const enabledMaps = parseEnabledMaps(await getParameter(parameterNames.enabledMaps, ""));
  const unsupportedEnabledMaps = enabledMaps.filter((map) => !isSupportedAsaMap(map));
  if (unsupportedEnabledMaps.length > 0) {
    return message(
      `The enabled-maps parameter contains unsupported map values: ${unsupportedEnabledMaps.join(", ")}. Update the parameter and re-register the Discord commands.`,
      true,
    );
  }
  if (!isSupportedAsaMap(options.map)) {
    return message(`Unsupported map: ${options.map}. Re-register the Discord commands after adding a supported map.`, true);
  }
  if (enabledMaps.length > 0 && !enabledMaps.includes(options.map)) {
    return message(
      `Map ${options.map} is not enabled for this server. Enabled maps: ${enabledMaps.join(", ")}. If this is the default map, update the default-map parameter, then re-register the Discord commands.`,
      true,
    );
  }
  const sessionName = await getParameter(parameterNames.sessionName, "private-asa");
  const configuredMaxPlayers = Number(await getParameter(parameterNames.maxPlayers, "4"));
  if (!optionValue<number>(interaction, "max_players") && Number.isFinite(configuredMaxPlayers)) {
    options.maxPlayers = Math.min(Math.max(configuredMaxPlayers, 1), MAX_PLAYERS);
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(sessionName)) {
    return message("Configured session name is invalid. Use only A-Z, a-z, 0-9, underscore, dot, and hyphen.", true);
  }
  const existing = await store.getServer();
  if (
    (existing?.status === "STARTING" || existing?.status === "RUNNING" || existing?.status === "STOPPING") &&
    !isStaleStarting(existing, now)
  ) {
    return message(`ASA server is already ${existing.status}.\nConnect: ${existing.connectCommand ?? "not available yet"}`, true);
  }
  const budgetPk = monthKey(now);
  const budget = await store.getBudget(budgetPk);
  const budgetDecision = canStart({ budget, requestedHours: options.durationHours, monthlyRuntimeHoursLimit });
  if (!budgetDecision.ok) return message(budgetDecision.reason, true);

  const expiresAt = new Date(now.getTime() + options.durationHours * 60 * 60 * 1000);
  const userId = userIdFromInteraction(interaction) ?? null;
  const state: ServerState = {
    pk: "SERVER",
    status: "STARTING",
    taskArn: null,
    clusterArn,
    startedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    publicIp: null,
    connectCommand: null,
    sessionName,
    mapName: options.map,
    maxPlayers: options.maxPlayers,
    startedByDiscordUserId: userId,
    startedFromChannelId: interaction.channel_id ?? null,
    lastBackupAt: null,
    lastStopReason: null,
    updatedAt: now.toISOString(),
  };
  await store.putServerStarting(state, new Date(now.getTime() - startingStaleMs).toISOString());

  let taskArn: string;
  try {
    const runTask = await ecs.send(
      new RunTaskCommand({
        cluster: clusterArn,
        taskDefinition: taskDefinitionArn,
        platformVersion: "LATEST",
        capacityProviderStrategy: enableOnDemandFallback
          ? [
              { capacityProvider: "FARGATE_SPOT", weight: 1, base: 0 },
              { capacityProvider: "FARGATE", weight: 1, base: 0 },
            ]
          : [{ capacityProvider: "FARGATE_SPOT", weight: 1, base: 0 }],
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: "ENABLED",
            subnets: subnetIds,
            securityGroups: [securityGroupId],
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "AsaServerContainer",
              environment: [
                { name: "ASA_MAP", value: options.map },
                { name: "ASA_SESSION_NAME", value: sessionName },
                { name: "ASA_MAX_PLAYERS", value: String(options.maxPlayers) },
                { name: "ASA_EXPIRES_AT", value: expiresAt.toISOString() },
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
    await store.updateServerStatus("ERROR", { lastStopReason: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  try {
    await store.updateServerStatus("STARTING", { taskArn });
    await createStopSchedule(expiresAt);
  } catch (error) {
    await ecs
      .send(new StopTaskCommand({ cluster: clusterArn, task: taskArn, reason: "START_ROLLBACK after initialization failure" }))
      .catch((stopError) => console.error("Failed to roll back started task", stopError));
    await store
      .updateServerStatus("STOPPING", { lastStopReason: error instanceof Error ? error.message : String(error) })
      .catch((stateError) => console.error("Failed to record start rollback", stateError));
    throw new Error(`ASA task was stopped because start initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await store.incrementStartCount(budgetPk).catch((error) => console.error("Failed to increment start count", error));
  if (options.publicNotify) {
    try {
      const webhook = await getSecret(secretNames.notificationWebhookUrl);
      await postWebhook(
        webhook,
        `ASA server start requested by <@${userId ?? "unknown"}>.\nMap: ${options.map}\nTTL: ${options.durationHours}h\nStatus: STARTING`,
      );
    } catch (error) {
      console.error("Failed to post start notification", error);
    }
  }
  return message(`ASA start requested.\nMap: ${options.map}\nAuto-stop: ${expiresAt.toISOString()}`, true);
}

async function handleStop(interaction: DiscordInteraction) {
  const state = await store.getServer();
  if (isStaleStarting(state, new Date())) {
    await store.updateServerStatus("STOPPED", { lastStopReason: "STALE_START_RESET" });
    return message("Stale STARTING state was reset. No ECS task was running.", true);
  }
  if (!state?.taskArn || (state.status !== "RUNNING" && state.status !== "STARTING")) {
    return message("ASA server is not running.", true);
  }
  await ecs.send(
    new StopTaskCommand({
      cluster: clusterArn,
      task: state.taskArn,
      reason: `USER_REQUEST by ${userIdFromInteraction(interaction) ?? "unknown"}`,
    }),
  );
  await store.updateServerStatus("STOPPING", { lastStopReason: "USER_REQUEST" });
  await deleteStopSchedule();
  const webhook = await getSecret(secretNames.notificationWebhookUrl);
  await postWebhook(webhook, "ASA server is stopping.\nReason: USER_REQUEST\nSaving world and uploading backup to S3...");
  return message("ASA stop requested.", true);
}

async function handleStatus() {
  const state = await store.getServer();
  const budget = await store.getBudget(monthKey());
  const runtimeSeconds = budget?.runtimeSeconds ?? 0;
  if (!state) return message("Status: STOPPED\nThis month: 0h", true);
  return message(
    [
      `Status: ${state.status}`,
      `Map: ${state.mapName}`,
      `Players: unknown / ${state.maxPlayers}`,
      `Started: ${state.startedAt ?? "N/A"}`,
      `Expires: ${state.expiresAt ?? "N/A"}`,
      `Connect: ${state.connectCommand ?? "not available"}`,
      `This month: ${hours(runtimeSeconds)}h / ${monthlyRuntimeHoursLimit}h`,
      `Estimated cost (conservative): ¥${Math.round(budget?.estimatedCostJpy ?? 0)}`,
      `Estimated cost (Fargate Spot approx.): ¥${Math.round(spotCostJpy(runtimeSeconds))}`,
    ].join("\n"),
    true,
  );
}

async function handleInfo() {
  const state = await store.getServer();
  if (!state || state.status === "STOPPED") return message("ASA server is stopped.", true);
  const passwordLine = allowDiscordPasswordNotification ? `Password: ${await getSecret(secretNames.serverPassword)}` : "Password: hidden";
  return message(
    [`Server: ${state.sessionName}`, `Map: ${state.mapName}`, `Connect: ${state.connectCommand ?? "not available"}`, passwordLine].join(
      "\n",
    ),
    true,
  );
}

async function handleBackup() {
  const state = await store.getServer();
  if (state?.status === "RUNNING") {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: `${s3RuntimePrefix}backup-request.json`,
        Body: JSON.stringify({ requestedAt: new Date().toISOString() }),
        ContentType: "application/json",
      }),
    );
    return message("Backup requested. The container checks for requests periodically.", true);
  }
  return message(`ASA server is not running.\nLast backup: ${state?.lastBackupAt ?? "unknown"}`, true);
}

async function handleBudget() {
  const budget = await store.getBudget(monthKey());
  const runtimeSeconds = budget?.runtimeSeconds ?? 0;
  return message(
    [
      `Starts: ${budget?.startCount ?? 0}`,
      `Runtime: ${hours(runtimeSeconds)}h / ${monthlyRuntimeHoursLimit}h`,
      `Estimated cost (conservative): ¥${Math.round(budget?.estimatedCostJpy ?? 0)}`,
      `Estimated cost (Fargate Spot approx.): ¥${Math.round(spotCostJpy(runtimeSeconds))}`,
    ].join("\n"),
    true,
  );
}

async function routeCommand(interaction: DiscordInteraction) {
  const command = subcommandName(interaction);
  switch (command) {
    case "start":
      return handleStart(interaction);
    case "stop":
      return handleStop(interaction);
    case "status":
      return handleStatus();
    case "info":
      return handleInfo();
    case "backup":
      return handleBackup();
    case "budget":
      return handleBudget();
    default:
      return message("Unknown ASA command.", true);
  }
}

async function handleAsyncCommand(event: AsyncCommandEvent): Promise<void> {
  try {
    const result = await routeCommand(event.interaction);
    await postInteractionFollowup(event.interaction, result.data.content, result.data.flags === EPHEMERAL);
  } catch (error) {
    console.error(error);
    await postInteractionFollowup(event.interaction, `Command failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
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
  if (interaction.type === InteractionType.Ping) {
    return response(200, { type: InteractionResponseType.Pong });
  }

  if (interaction.guild_id !== guildId) return response(200, message("This command is not available in this guild.", true));

  if (!isAuthorized(interaction, allowedUsers, allowedRoles))
    return response(200, message("You are not allowed to operate the ASA server.", true));

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
