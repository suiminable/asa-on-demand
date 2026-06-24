import type { Task } from "@aws-sdk/client-ecs";

export function eniIdFromTask(task: Task): string | undefined {
  for (const attachment of task.attachments ?? []) {
    if (attachment.type !== "ElasticNetworkInterface") continue;
    const eni = attachment.details?.find((detail) => detail.name === "networkInterfaceId")?.value;
    if (eni) return eni;
  }
  return undefined;
}

export function connectCommandForIp(publicIp: string | undefined, domainName?: string): string | null {
  const host = domainName || publicIp;
  return host ? `open ${host}:7777` : null;
}
