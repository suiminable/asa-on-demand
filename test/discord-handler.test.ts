import type { APIGatewayProxyEventV2 } from "aws-lambda";
import nacl from "tweetnacl";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lambdaSend: vi.fn(),
  parameters: new Map<string, string>(),
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

const keyPair = nacl.sign.keyPair();
const publicKey = Buffer.from(keyPair.publicKey).toString("hex");
let handler: typeof import("../src/lambdas/discord-interactions/index.js").handler;

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

beforeAll(async () => {
  Object.assign(process.env, {
    TABLE_NAME: "table",
    CLUSTER_ARN: "cluster",
    TASK_DEFINITION_ARN: "task-definition",
    SUBNET_IDS: "subnet-1",
    SECURITY_GROUP_ID: "sg-1",
    STOP_SCHEDULE_NAME: "stop-schedule",
    STOP_SCHEDULER_ROLE_ARN: "scheduler-role",
    S3_BUCKET: "bucket",
    AWS_LAMBDA_FUNCTION_NAME: "discord-handler",
  });
  mocks.parameters.set("/asa/discord/public-key", publicKey);
  mocks.parameters.set("/asa/discord/guild-id", "guild-1");
  mocks.parameters.set("/asa/discord/allowed-user-ids", '["user-1"]');
  mocks.parameters.set("/asa/discord/allowed-role-ids", "[]");
  ({ handler } = await import("../src/lambdas/discord-interactions/index.js"));
});

beforeEach(() => {
  mocks.lambdaSend.mockReset().mockResolvedValue({ StatusCode: 202 });
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
});
