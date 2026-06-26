import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const parameterSuffixes = {
  discordApplicationId: "/discord/application-id",
  discordPublicKey: "/discord/public-key",
  discordGuildId: "/discord/guild-id",
  allowedRoleIds: "/discord/allowed-role-ids",
  allowedUserIds: "/discord/allowed-user-ids",
  sessionName: "/server/session-name",
  defaultMap: "/server/default-map",
  maxPlayers: "/server/max-players",
} as const;

const secretSuffixes = {
  discordBotToken: "/discord/bot-token",
  notificationWebhookUrl: "/discord/notification-webhook-url",
  serverPassword: "/server/password",
  serverAdminPassword: "/server/admin-password",
} as const;

export type ParameterNames = Record<keyof typeof parameterSuffixes, string>;
export type SecretNames = Record<keyof typeof secretSuffixes, string>;

export function normalizeConfigPrefix(prefix = "/asa"): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return `/${trimmed || "asa"}`;
}

function namesFor<T extends Record<string, string>>(prefix: string | undefined, suffixes: T): Record<keyof T, string> {
  const normalized = normalizeConfigPrefix(prefix);
  return Object.fromEntries(Object.entries(suffixes).map(([key, suffix]) => [key, `${normalized}${suffix}`])) as Record<keyof T, string>;
}

export function parameterNamesFor(prefix?: string): ParameterNames {
  return namesFor(prefix, parameterSuffixes);
}

export function secretNamesFor(prefix?: string): SecretNames {
  return namesFor(prefix, secretSuffixes);
}

export const parameterNames = parameterNamesFor();
export const secretNames = secretNamesFor();

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
