import type { AsaMapDefinition } from "./maps.js";

function normalizePrefix(prefix: string): string {
  const value = prefix.trim().replace(/^\/+|\/+$/g, "");
  return value ? `${value}/` : "";
}

export function mapStatePk(mapId: string): `MAP#${string}` {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mapId)) throw new Error(`Invalid mapId: ${mapId}`);
  return `MAP#${mapId}`;
}

export function mapStorageKeys(resourcePrefix: string, mapId: string) {
  mapStatePk(mapId);
  const root = `${normalizePrefix(resourcePrefix)}maps/${mapId}/`;
  const runtimePrefix = `${root}runtime/`;
  return {
    saveKey: `${root}saves/current.tar.zst`,
    backupPrefix: `${root}backups/`,
    runtimePrefix,
    heartbeatKey: `${runtimePrefix}heartbeat.json`,
    readyKey: `${runtimePrefix}ready.json`,
    backupRequestKey: `${runtimePrefix}backup-request.json`,
    lastBackupKey: `${runtimePrefix}last-backup.json`,
    mapConfigPrefix: `${normalizePrefix(resourcePrefix)}config/maps/${mapId}/`,
    commonConfigPrefix: `${normalizePrefix(resourcePrefix)}config/common/`,
  };
}

export function taskGroup(mapId: string, runId: string): string {
  mapStatePk(mapId);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(runId)) throw new Error(`Invalid runId: ${runId}`);
  return `asa-map:${mapId}:${runId}`;
}

export function parseTaskGroup(value: string | undefined): { mapId: string; runId: string } | undefined {
  const match = /^asa-map:([a-z0-9]+(?:-[a-z0-9]+)*):([A-Za-z0-9_-]{8,64})$/.exec(value ?? "");
  return match ? { mapId: match[1], runId: match[2] } : undefined;
}

export function stopScheduleName(environment: string, mapId: string): string {
  mapStatePk(mapId);
  const normalized =
    environment
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "default";
  const value = `asa-${normalized}-${mapId}-auto-stop`;
  if (value.length > 64) throw new Error(`Stop schedule name exceeds 64 characters: ${value}`);
  return value;
}

export function mapDnsName(definition: AsaMapDefinition, baseDomain: string): string {
  const domain = baseDomain
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  if (!domain) throw new Error("Base domain is empty.");
  return `${definition.mapId}.${domain}`;
}
