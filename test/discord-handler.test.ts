import type { APIGatewayProxyEventV2 } from "aws-lambda";
import nacl from "tweetnacl";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  ecsSend: vi.fn(),
  lambdaSend: vi.fn(),
  s3Send: vi.fn(),
  schedulerSend: vi.fn(),
  getServer: vi.fn(),
  getBudget: vi.fn(),
  putServerStarting: vi.fn(),
  updateServerStatus: vi.fn(),
  incrementStartCount: vi.fn(),
  parameters: new Map<string, string>(),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  RunTaskCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  StopTaskCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  ECSClient: class {
    send = mocks.ecsSend;
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  InvokeCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  LambdaClient: class {
    send = mocks.lambdaSend;
  },
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  GetParameterCommand: class {
    constructor(readonly input: { Name: string }) {}
  },
  SSMClient: class {
    send(command: { input: { Name: string } }) {
      const value = mocks.parameters.get(command.input.Name);
      if (value === undefined) throw Object.assign(new Error("Parameter not found"), { name: "ParameterNotFound" });
      return Promise.resolve({ Parameter: { Value: value } });
    }
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  S3Client: class {
    send = mocks.s3Send;
  },
}));

vi.mock("@aws-sdk/client-scheduler", () => ({
  CreateScheduleCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteScheduleCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  SchedulerClient: class {
    send = mocks.schedulerSend;
  },
}));

vi.mock("../src/shared/state.js", () => ({
  StateStore: class {
    getServer = mocks.getServer;
    getBudget = mocks.getBudget;
    putServerStarting = mocks.putServerStarting;
    updateServerStatus = mocks.updateServerStatus;
    incrementStartCount = mocks.incrementStartCount;
  },
}));

const keyPair = nacl.sign.keyPair();
const publicKey = Buffer.from(keyPair.publicKey).toString("hex");
let handler: typeof import("../src/lambdas/discord-interactions/index.js").handler;

function startInteraction(map?: string, idleMinutes?: number, publicNotify?: boolean) {
  const options: Array<{ name: string; value: string | number | boolean }> = [];
  if (map) options.push({ name: "map", value: map });
  if (idleMinutes !== undefined) options.push({ name: "idle_minutes", value: idleMinutes });
  if (publicNotify !== undefined) options.push({ name: "public_notify", value: publicNotify });
  return {
    id: "interaction-start",
    application_id: "application-1",
    token: "token-start",
    type: 2,
    guild_id: "guild-1",
    member: { user: { id: "user-1" }, roles: [] },
    data: {
      options: [
        {
          type: 1,
          name: "start",
          options,
        },
      ],
    },
  };
}

async function runAsyncStart(map?: string, idleMinutes?: number, publicNotify?: boolean): Promise<string> {
  await handler({ source: "asa.discord.command", interaction: startInteraction(map, idleMinutes, publicNotify) });
  const request = mocks.fetch.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  return JSON.parse(request?.body ?? "{}").content ?? "";
}

async function runAsyncStatus(): Promise<string> {
  await handler({
    source: "asa.discord.command",
    interaction: {
      id: "interaction-status",
      application_id: "application-1",
      token: "token-status",
      type: 2,
      guild_id: "guild-1",
      member: { user: { id: "user-1" }, roles: [] },
      data: { options: [{ type: 1, name: "status" }] },
    },
  });
  const request = mocks.fetch.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  return JSON.parse(request?.body ?? "{}").content ?? "";
}

function runningServer() {
  return {
    pk: "SERVER",
    status: "RUNNING",
    taskArn: "task-1",
    clusterArn: "cluster",
    startedAt: "2026-07-06T00:00:00.000Z",
    taskStartedAt: "2026-07-06T00:00:00.000Z",
    publicIp: "192.0.2.1",
    connectCommand: "open 192.0.2.1:7777",
    sessionName: "private-asa",
    mapName: "TheIsland_WP",
    eventModId: "927091",
    maxPlayers: 4,
    idleTimeoutMinutes: 30,
    idleSince: null,
    lastHeartbeatAt: null,
    startedByDiscordUserId: "user-1",
    startedFromChannelId: null,
    lastBackupAt: null,
    lastStopReason: null,
    updatedAt: "2026-07-06T00:00:00.000Z",
  };
}

function signedEvent(interaction: object): APIGatewayProxyEventV2 {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + body), keyPair.secretKey)).toString("hex");
  return {
    body,
    headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

beforeAll(() => {
  Object.assign(process.env, {
    TABLE_NAME: "table",
    CLUSTER_ARN: "cluster",
    TASK_DEFINITION_ARN: "task-definition",
    SUBNET_IDS: "subnet-1",
    SECURITY_GROUP_ID: "sg-1",
    STOP_SCHEDULE_NAME: "stop-schedule",
    STOP_SCHEDULER_ROLE_ARN: "scheduler-role",
    STOP_SERVER_FUNCTION_ARN: "stop-function",
    S3_BUCKET: "bucket",
    AWS_LAMBDA_FUNCTION_NAME: "discord-handler",
  });
  vi.stubGlobal("fetch", mocks.fetch);
});

beforeEach(async () => {
  vi.resetModules();
  mocks.parameters.clear();
  mocks.parameters.set("/asa/discord/public-key", publicKey);
  mocks.parameters.set("/asa/discord/guild-id", "guild-1");
  mocks.parameters.set("/asa/discord/allowed-user-ids", '["user-1"]');
  mocks.parameters.set("/asa/discord/allowed-role-ids", "[]");
  mocks.parameters.set("/asa/server/session-name", "invalid session name");
  mocks.lambdaSend.mockReset().mockResolvedValue({ StatusCode: 202 });
  mocks.ecsSend.mockReset().mockResolvedValue({ tasks: [{ taskArn: "task-1" }] });
  mocks.s3Send.mockReset();
  mocks.schedulerSend.mockReset().mockResolvedValue({});
  mocks.getServer.mockReset();
  mocks.getBudget.mockReset().mockResolvedValue(undefined);
  mocks.putServerStarting.mockReset().mockResolvedValue(undefined);
  mocks.updateServerStatus.mockReset().mockResolvedValue(undefined);
  mocks.incrementStartCount.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue({ ok: true });
  ({ handler } = await import("../src/lambdas/discord-interactions/index.js"));
});

describe("Discord interaction handler", () => {
  it("answers signed pings without invoking command work", async () => {
    const result = await handler(signedEvent({ type: 1 }));

    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(result?.body ?? "{}")).toEqual({ type: 1 });
    expect(mocks.lambdaSend).not.toHaveBeenCalled();
  });

  it("rejects users outside the allowlist", async () => {
    const result = await handler(
      signedEvent({
        id: "interaction-1",
        application_id: "application-1",
        token: "token-1",
        type: 2,
        guild_id: "guild-1",
        member: { user: { id: "user-2" }, roles: [] },
      }),
    );

    expect(JSON.parse(result?.body ?? "{}").data.content).toContain("not allowed");
    expect(mocks.lambdaSend).not.toHaveBeenCalled();
  });

  it("defers authorized commands and invokes itself asynchronously", async () => {
    const interaction = {
      id: "interaction-2",
      application_id: "application-1",
      token: "token-2",
      type: 2,
      guild_id: "guild-1",
      member: { user: { id: "user-1" }, roles: [] },
      data: { options: [{ type: 1, name: "status" }] },
    };
    const result = await handler(signedEvent(interaction));

    expect(JSON.parse(result?.body ?? "{}")).toMatchObject({ type: 5, data: { flags: 64 } });
    expect(mocks.lambdaSend).toHaveBeenCalledOnce();
    const command = mocks.lambdaSend.mock.calls[0][0] as { input: { FunctionName: string; InvocationType: string; Payload: Uint8Array } };
    expect(command.input.FunctionName).toBe("discord-handler");
    expect(command.input.InvocationType).toBe("Event");
    expect(JSON.parse(Buffer.from(command.input.Payload).toString())).toEqual({ source: "asa.discord.command", interaction });
  });

  it("allows every supported map when enabled-maps is not configured", async () => {
    expect(await runAsyncStart("Ragnarok_WP")).toContain("Configured session name is invalid");
  });

  it("rejects a map outside the configured enabled-maps subset", async () => {
    mocks.parameters.set("/asa/server/enabled-maps", "TheIsland_WP,ScorchedEarth_WP");

    const content = await runAsyncStart("Ragnarok_WP");

    expect(content).toContain("Map Ragnarok_WP is not enabled for this server");
    expect(content).toContain("TheIsland_WP, ScorchedEarth_WP");
  });

  it("accepts a map inside the configured enabled-maps subset", async () => {
    mocks.parameters.set("/asa/server/enabled-maps", "TheIsland_WP,ScorchedEarth_WP");

    expect(await runAsyncStart("ScorchedEarth_WP")).toContain("Configured session name is invalid");
  });

  it("rejects a configured default map outside the enabled-maps subset", async () => {
    mocks.parameters.set("/asa/server/default-map", "Ragnarok_WP");
    mocks.parameters.set("/asa/server/enabled-maps", "TheIsland_WP,ScorchedEarth_WP");

    const content = await runAsyncStart();

    expect(content).toContain("Map Ragnarok_WP is not enabled for this server");
    expect(content).toContain("update the default-map parameter");
  });

  it("reports unsupported values in the enabled-maps parameter", async () => {
    mocks.parameters.set("/asa/server/enabled-maps", "TheIsland_WP,Unknown_WP");

    expect(await runAsyncStart("TheIsland_WP")).toContain("enabled-maps parameter contains unsupported map values: Unknown_WP");
  });

  it("rejects an invalid event mod ID from Parameter Store", async () => {
    mocks.parameters.set("/asa/server/event-mod-id", "summer-bash");

    const content = await runAsyncStart("TheIsland_WP");

    expect(content).toContain("Configured event-mod-id is invalid");
    expect(content).toContain("numeric CurseForge project ID or None");
    expect(mocks.ecsSend).not.toHaveBeenCalled();
  });

  it("passes the selected event mod ID to the ECS task and stores it", async () => {
    mocks.parameters.set("/asa/server/session-name", "private-asa");
    mocks.parameters.set("/asa/server/max-players", "4");
    mocks.parameters.set("/asa/server/event-mod-id", "927091");
    mocks.getServer.mockResolvedValue(undefined);

    const content = await runAsyncStart("TheIsland_WP", undefined, false);

    expect(content).toContain("Event: mod 927091");
    expect(mocks.putServerStarting).toHaveBeenCalledWith(expect.objectContaining({ eventModId: "927091" }), expect.any(String));
    const runTask = mocks.ecsSend.mock.calls[0][0] as { input: { overrides: { containerOverrides: Array<{ environment: unknown[] }> } } };
    expect(runTask.input.overrides.containerOverrides[0].environment).toContainEqual({ name: "ASA_EVENT_MOD_ID", value: "927091" });
  });

  it("starts with the default 30-minute idle timeout and a recurring check", async () => {
    mocks.parameters.set("/asa/server/session-name", "private-asa");
    mocks.parameters.set("/asa/server/max-players", "4");
    mocks.getServer.mockResolvedValue(undefined);

    const content = await runAsyncStart("TheIsland_WP", undefined, false);

    expect(content).toContain("no players for 30m");
    expect(content).toContain("Event: not configured");
    expect(mocks.putServerStarting).toHaveBeenCalledWith(
      expect.objectContaining({ eventModId: null, idleTimeoutMinutes: 30, idleSince: null, lastHeartbeatAt: null }),
      expect.any(String),
    );
    expect(mocks.putServerStarting.mock.calls[0][0]).not.toHaveProperty("expiresAt");
    const runTask = mocks.ecsSend.mock.calls[0][0] as { input: { overrides: { containerOverrides: Array<{ environment: unknown[] }> } } };
    expect(runTask.input.overrides.containerOverrides[0].environment).toEqual(
      expect.arrayContaining([
        { name: "IDLE_TIMEOUT_MINUTES", value: "30" },
        { name: "MONTHLY_RUNTIME_HOURS_LIMIT", value: "80" },
      ]),
    );
    expect(runTask.input.overrides.containerOverrides[0].environment).not.toContainEqual(
      expect.objectContaining({ name: "ASA_EVENT_MOD_ID" }),
    );
    const createSchedule = mocks.schedulerSend.mock.calls
      .map(([command]) => command)
      .find((command) => "ScheduleExpression" in command.input);
    expect(createSchedule.input).toMatchObject({
      ScheduleExpression: "rate(1 minute)",
      Target: { Input: JSON.stringify({ source: "IDLE_CHECK" }) },
    });
  });

  it("stores an explicit idle_minutes value for the session", async () => {
    mocks.parameters.set("/asa/server/session-name", "private-asa");
    mocks.parameters.set("/asa/server/max-players", "4");
    mocks.getServer.mockResolvedValue(undefined);

    expect(await runAsyncStart("TheIsland_WP", 45, false)).toContain("no players for 45m");
    expect(mocks.putServerStarting).toHaveBeenCalledWith(expect.objectContaining({ idleTimeoutMinutes: 45 }), expect.any(String));
  });

  it("rejects idle_minutes outside the documented range", async () => {
    expect(await runAsyncStart("TheIsland_WP", 1441, false)).toContain("idle_minutes must be an integer from 1 to 1440");
    expect(mocks.ecsSend).not.toHaveBeenCalled();
  });

  it("shows the player count from a fresh heartbeat", async () => {
    mocks.getServer.mockResolvedValue(runningServer());
    mocks.s3Send.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify({ playerCount: 2, updatedAt: new Date(Date.now() - 1000).toISOString() }) },
    });

    expect(await runAsyncStatus()).toContain("Players: 2 / 4");
    expect(await runAsyncStatus()).toContain("Event: mod 927091");
    expect(await runAsyncStatus()).toContain("Auto-stop: no players for 30m / monthly limit 80h");
  });

  it("shows unknown when the heartbeat is stale", async () => {
    mocks.getServer.mockResolvedValue(runningServer());
    mocks.s3Send.mockResolvedValue({
      Body: {
        transformToString: async () => JSON.stringify({ playerCount: 2, updatedAt: new Date(Date.now() - 181_000).toISOString() }),
      },
    });

    expect(await runAsyncStatus()).toContain("Players: unknown / 4");
  });

  it("shows unknown when the heartbeat does not exist", async () => {
    mocks.getServer.mockResolvedValue(runningServer());
    mocks.s3Send.mockRejectedValue(Object.assign(new Error("Heartbeat not found"), { name: "NoSuchKey" }));

    expect(await runAsyncStatus()).toContain("Players: unknown / 4");
  });
});
