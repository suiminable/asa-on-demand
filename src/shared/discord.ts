import nacl from "tweetnacl";

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
} as const;

export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
} as const;

export const EPHEMERAL = 1 << 6;

export interface DiscordMember {
  roles?: string[];
  user?: { id?: string; username?: string };
}

export interface DiscordInteraction {
  id?: string;
  application_id?: string;
  token?: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: DiscordMember;
  user?: { id?: string; username?: string };
  data?: {
    name?: string;
    options?: Array<{
      name: string;
      type: number;
      value?: string | number | boolean;
      options?: Array<{ name: string; value?: string | number | boolean }>;
    }>;
  };
}

export function verifyDiscordSignature(params: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  now?: Date;
  maxAgeSeconds?: number;
}): boolean {
  try {
    if (!params.signature || !params.timestamp || !params.publicKey) return false;
    if (!/^[0-9a-f]{128}$/i.test(params.signature) || !/^[0-9a-f]{64}$/i.test(params.publicKey)) return false;
    const timestampSeconds = Number(params.timestamp);
    if (!Number.isFinite(timestampSeconds)) return false;
    const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > (params.maxAgeSeconds ?? 300)) return false;
    const message = Buffer.from(params.timestamp + params.rawBody);
    const signature = Buffer.from(params.signature, "hex");
    const publicKey = Buffer.from(params.publicKey, "hex");
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

export function userIdFromInteraction(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

export function isAuthorized(interaction: DiscordInteraction, allowedUserIds: string[], allowedRoleIds: string[]): boolean {
  const userId = userIdFromInteraction(interaction);
  if (userId && allowedUserIds.includes(userId)) return true;
  const roles = interaction.member?.roles ?? [];
  return roles.some((roleId) => allowedRoleIds.includes(roleId));
}

export function message(content: string, ephemeral = true) {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: ephemeral ? EPHEMERAL : undefined },
  };
}

export function deferred(ephemeral = true) {
  return {
    type: InteractionResponseType.DeferredChannelMessageWithSource,
    data: { flags: ephemeral ? EPHEMERAL : undefined },
  };
}

export async function postWebhook(webhookUrl: string | undefined, content: string): Promise<void> {
  if (!webhookUrl) return;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
}

export async function postInteractionFollowup(interaction: DiscordInteraction, content: string, ephemeral = true): Promise<void> {
  if (!interaction.application_id || !interaction.token) throw new Error("Interaction follow-up credentials are missing.");
  const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, flags: ephemeral ? EPHEMERAL : undefined }),
  });
  if (!response.ok) throw new Error(`Discord interaction follow-up failed: ${response.status} ${await response.text()}`);
}

export function optionValue<T extends string | number | boolean>(interaction: DiscordInteraction, name: string): T | undefined {
  const subcommand = interaction.data?.options?.[0];
  const options = subcommand?.options ?? interaction.data?.options ?? [];
  return options.find((option) => option.name === name)?.value as T | undefined;
}

export function subcommandName(interaction: DiscordInteraction): string | undefined {
  return interaction.data?.options?.[0]?.name;
}
