import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

export const parameterNames = {
  discordApplicationId: "/asa/discord/application-id",
  discordPublicKey: "/asa/discord/public-key",
  discordGuildId: "/asa/discord/guild-id",
  allowedRoleIds: "/asa/discord/allowed-role-ids",
  allowedUserIds: "/asa/discord/allowed-user-ids",
  sessionName: "/asa/server/session-name",
  defaultMap: "/asa/server/default-map",
  maxPlayers: "/asa/server/max-players",
} as const;

export const secretNames = {
  discordBotToken: "/asa/discord/bot-token",
  notificationWebhookUrl: "/asa/discord/notification-webhook-url",
  serverPassword: "/asa/server/password",
  serverAdminPassword: "/asa/server/admin-password",
} as const;

export async function getParameter(name: string, fallback?: string): Promise<string> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    return result.Parameter?.Value ?? fallback ?? "";
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

export async function getJsonArrayParameter(name: string): Promise<string[]> {
  const value = await getParameter(name, "[]");
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export async function getSecret(name: string): Promise<string> {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
  return result.SecretString ?? "";
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Invalid integer environment variable ${name}: ${value}`);
  return parsed;
}

