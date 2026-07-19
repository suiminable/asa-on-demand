import type { APIGatewayProxyEventV2 } from "aws-lambda";
import nacl from "tweetnacl";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  ecsSend: vi.fn(),
  lambdaSend: vi.fn(),
  s3Send: vi.fn(),
  schedulerSend: vi.fn(),
  getMap: vi.fn(),
  getMaps: vi.fn(),
  getBudget: vi.fn(),
  getBudgets: vi.fn(),
  getCluster: vi.fn(),
  reserveMapStart: vi.fn(),
  attachStartedTask: vi.fn(),
  markOperationScheduled: vi.fn(),
  markMapStopping: vi.fn(),
  rollbackMapStart: vi.fn(),
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
    getMap = mocks.getMap;
    getMaps = mocks.getMaps;
    getBudget = mocks.getBudget;
    getBudgets = mocks.getBudgets;
    getCluster = mocks.getCluster;
    reserveMapStart = mocks.reserveMapStart;
    attachStartedTask = mocks.attachStartedTask;
    markOperationScheduled = mocks.markOperationScheduled;
    markMapStopping = mocks.markMapStopping;
    rollbackMapStart = mocks.rollbackMapStart;
  },
}));

const keyPair = nacl.sign.keyPair();
const publicKey = Buffer.from(keyPair.publicKey).toString("hex");
let handler: typeof import("../src/lambdas/discord-interactions/index.js").handler;

function interaction(
  command: string,
  options: Array<{ name: string; value: string | number | boolean }> = [],
  id = `interaction-${command}`,
) {
  return {
    id,
    application_id: "application-1",
    token: `token-${command}`,
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1" }, roles: [] },
    data: { options: [{ type: 1, name: command, options }] },
  };
}

async function runAsync(
  command: string,
  options: Array<{ name: string; value: string | number | boolean }> = [],
  id?: string,
): Promise<string> {
  await handler({ source: "asa.discord.command", interaction: interaction(command, options, id) });
  const request = mocks.fetch.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  return JSON.parse(request?.body ?? "{}").content ?? "";
}

function mapState(mapId: string, arkMapName: string, taskArn: string) {
  return {
    pk: `MAP#${mapId}`,
    mapId,
    arkMapName,
    status: "RUNNING",
    runId: `run-${mapId}-12345678`,
    taskArn,
    clusterArn: "cluster",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    taskStartedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    publicIp: "192.0.2.1",
    connectCommand: "open 192.0.2.1:7777",
    sessionName: `private-asa-${mapId}`,
    eventModId: null,
    maxPlayers: 4,
    idleTimeoutMinutes: 30,
    idleSince: null,
    lastHeartbeatAt: null,
    startedByDiscordUserId: "user-1",
    startedFromChannelId: "channel-1",
    readyAt: null,
    lastBackupAt: null,
    lastStopReason: null,
    lastEcsEventVersion: 1,
    reservations: [{ budgetPk: "BUDGET#2026-07", runtimeSeconds: 28_800 }],
    updatedAt: new Date().toISOString(),
  };
}

function signedEvent(value: object): APIGatewayProxyEventV2 {
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + body), keyPair.secretKey)).toString("hex");
  return { body, headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, isBase64Encoded: false } as never;
}

beforeAll(() => {
  Object.assign(process.env, {
    TABLE_NAME: "table",
    CLUSTER_ARN: "cluster",
    TASK_DEFINITION_ARN: "task-definition",
    SUBNET_IDS: "subnet-1,subnet-2",
    SECURITY_GROUP_ID: "sg-1",
    STOP_SCHEDULER_ROLE_ARN: "scheduler-role",
    STOP_SERVER_FUNCTION_ARN: "stop-function",
    S3_BUCKET: "bucket",
    RESOURCE_PREFIX: "env/",
    ENVIRONMENT_NAME: "env",
    MAX_CONCURRENT_MAPS: "2",
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
  mocks.parameters.set("/asa/server/session-name", "private-asa");
  mocks.parameters.set("/asa/server/default-map", "TheIsland_WP");
  mocks.parameters.set("/asa/server/enabled-maps", "TheIsland_WP,ScorchedEarth_WP");
  mocks.parameters.set("/asa/server/max-players", "4");
  mocks.fetch.mockReset().mockResolvedValue({ ok: true });
  mocks.ecsSend.mockReset().mockResolvedValue({ tasks: [{ taskArn: "task-1" }] });
  mocks.lambdaSend.mockReset().mockResolvedValue({ StatusCode: 202 });
  mocks.s3Send.mockReset();
  mocks.schedulerSend.mockReset().mockResolvedValue({});
  mocks.getMap.mockReset();
  mocks.getMaps.mockReset().mockResolvedValue([]);
  mocks.getBudget.mockReset();
  mocks.getBudgets.mockReset().mockResolvedValue(new Map());
  mocks.getCluster.mockReset();
  mocks.reserveMapStart.mockReset().mockResolvedValue(true);
  mocks.attachStartedTask.mockReset().mockResolvedValue(true);
  mocks.markOperationScheduled.mockReset().mockResolvedValue(true);
  mocks.markMapStopping.mockReset().mockResolvedValue(true);
  mocks.rollbackMapStart.mockReset().mockResolvedValue(true);
  ({ handler } = await import("../src/lambdas/discord-interactions/index.js"));
});

describe("Discord map control", () => {
  it("answers signed pings and defers authorized commands", async () => {
    expect(JSON.parse((await handler(signedEvent({ type: 1 })))?.body ?? "{}")).toEqual({ type: 1 });
    const result = await handler(signedEvent(interaction("status")));
    expect(JSON.parse(result?.body ?? "{}")).toMatchObject({ type: 5, data: { flags: 64 } });
    expect(mocks.lambdaSend).toHaveBeenCalledOnce();
  });

  it("claims a map generation transactionally and runs a map-scoped ECS task", async () => {
    const content = await runAsync(
      "start",
      [
        { name: "map", value: "ScorchedEarth_WP" },
        { name: "session_hours", value: 8 },
        { name: "public_notify", value: false },
      ],
      "interaction-start-scored",
    );
    expect(content).toContain("Scorched Earth");
    expect(content).toContain("private-asa-scorched");
    expect(mocks.reserveMapStart).toHaveBeenCalledWith(
      expect.objectContaining({
        maxConcurrentMaps: 2,
        state: expect.objectContaining({ pk: "MAP#scorched-earth", mapId: "scorched-earth", arkMapName: "ScorchedEarth_WP" }),
      }),
    );
    const command = mocks.ecsSend.mock.calls[0][0] as {
      input: {
        group: string;
        clientToken: string;
        startedBy: string;
        tags: Array<{ key: string; value: string }>;
        overrides: { containerOverrides: Array<{ environment: Array<{ name: string; value: string }> }> };
      };
    };
    expect(command.input.group).toMatch(/^asa-map:scorched-earth:/);
    expect(command.input.clientToken).toBe(command.input.startedBy);
    expect(command.input.tags).toEqual(
      expect.arrayContaining([
        { key: "asa:map-id", value: "scorched-earth" },
        { key: "asa:run-id", value: command.input.clientToken },
      ]),
    );
    expect(command.input.overrides.containerOverrides[0].environment).toEqual(
      expect.arrayContaining([
        { name: "ASA_MAP_ID", value: "scorched-earth" },
        { name: "S3_SAVE_KEY", value: "env/maps/scorched-earth/saves/current.tar.zst" },
        { name: "HEARTBEAT_KEY", value: "env/maps/scorched-earth/runtime/heartbeat.json" },
      ]),
    );
    const create = mocks.schedulerSend.mock.calls.map(([value]) => value).find((value) => value.input.ScheduleExpression);
    expect(JSON.parse(create.input.Target.Input)).toMatchObject({ mapId: "scorched-earth", expectedTaskArn: "task-1" });
  });

  it("keeps the reservation until STOPPED settlement when post-launch schedule creation fails", async () => {
    mocks.schedulerSend.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("scheduler unavailable"));

    const content = await runAsync(
      "start",
      [
        { name: "map", value: "ScorchedEarth_WP" },
        { name: "public_notify", value: false },
      ],
      "interaction-start-schedule-failure",
    );

    expect(content).toContain("scheduler unavailable");
    expect(mocks.ecsSend).toHaveBeenCalledTimes(2);
    expect(mocks.markMapStopping).toHaveBeenCalledWith(
      "scorched-earth",
      expect.any(String),
      "task-1",
      expect.stringContaining("START_FINALIZATION_FAILED"),
    );
    expect(mocks.rollbackMapStart).not.toHaveBeenCalled();
  });

  it("surfaces a concurrent claim rejection without calling RunTask", async () => {
    mocks.reserveMapStart.mockResolvedValue(false);
    expect(await runAsync("start", [{ name: "map", value: "TheIsland_WP" }])).toContain("already active, concurrency is full");
    expect(mocks.ecsSend).not.toHaveBeenCalled();
  });

  it("lists enabled maps independently and requires a target for ambiguous stop", async () => {
    const island = mapState("the-island", "TheIsland_WP", "task-island");
    const scorched = mapState("scorched-earth", "ScorchedEarth_WP", "task-scorched");
    mocks.getMaps.mockResolvedValue([island, scorched]);
    mocks.s3Send.mockRejectedValue(new Error("no heartbeat"));
    const status = await runAsync("status");
    expect(status).toContain("the-island: RUNNING");
    expect(status).toContain("scorched-earth: RUNNING");
    const stop = await runAsync("stop");
    expect(stop).toContain("Multiple maps are active");
  });

  it("writes backup requests to the selected map and run generation", async () => {
    const state = mapState("the-island", "TheIsland_WP", "task-island");
    mocks.getMap.mockResolvedValue(state);
    expect(await runAsync("backup", [{ name: "map", value: "TheIsland_WP" }])).toContain("The Island");
    const put = mocks.s3Send.mock.calls[0][0];
    expect(put.input.Key).toBe("env/maps/the-island/runtime/backup-request.json");
    expect(JSON.parse(put.input.Body)).toMatchObject({ runId: state.runId });
  });

  it("shows READY only when the marker belongs to the selected Map generation", async () => {
    const state = mapState("the-island", "TheIsland_WP", "task-island");
    mocks.getMap.mockResolvedValue(state);
    mocks.s3Send.mockImplementation((command) => {
      if (command.input.Key.endsWith("heartbeat.json")) throw new Error("no heartbeat");
      return Promise.resolve({
        Body: {
          transformToString: async () =>
            JSON.stringify({ runId: "old-run-12345678", mapId: state.mapId, readyAt: new Date().toISOString() }),
        },
      });
    });
    expect(await runAsync("status", [{ name: "map", value: "TheIsland_WP" }])).toContain("Ready: not ready");

    mocks.s3Send.mockImplementation((command) => {
      if (command.input.Key.endsWith("heartbeat.json")) throw new Error("no heartbeat");
      return Promise.resolve({
        Body: {
          transformToString: async () => JSON.stringify({ runId: state.runId, mapId: state.mapId, readyAt: new Date().toISOString() }),
        },
      });
    });
    expect(await runAsync("status", [{ name: "map", value: "TheIsland_WP" }])).toContain("Ready: 20");
  });
});
