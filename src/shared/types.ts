export type ServerStatus = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";

export interface MapServerState {
  pk: `MAP#${string}`;
  mapId: string;
  arkMapName: string;
  status: ServerStatus;
  runId: string | null;
  taskArn: string | null;
  clusterArn: string;
  startedAt: string | null;
  taskStartedAt: string | null;
  publicIp: string | null;
  connectCommand: string | null;
  sessionName: string;
  eventModId?: string | null;
  maxPlayers: number;
  idleTimeoutMinutes: number;
  idleSince: string | null;
  lastHeartbeatAt: string | null;
  startedByDiscordUserId: string | null;
  startedFromChannelId: string | null;
  readyAt: string | null;
  lastBackupAt: string | null;
  lastStopReason: string | null;
  lastEcsEventVersion: number | null;
  updatedAt: string;
}

/** Kept as a read-only migration source for the v1 SERVER row. */
export interface ServerState {
  pk: "SERVER";
  status: ServerStatus;
  taskArn?: string | null;
  clusterArn?: string | null;
  startedAt?: string | null;
  taskStartedAt?: string | null;
  publicIp?: string | null;
  connectCommand?: string | null;
  sessionName: string;
  mapName: string;
  eventModId?: string | null;
  maxPlayers: number;
  idleTimeoutMinutes: number;
  idleSince?: string | null;
  lastHeartbeatAt?: string | null;
  startedByDiscordUserId?: string | null;
  startedFromChannelId?: string | null;
  lastBackupAt?: string | null;
  lastStopReason?: string | null;
  updatedAt: string;
}

export interface ClusterState {
  pk: "CLUSTER";
  activeCount: number;
  maxConcurrentMaps: number;
  schemaVersion: number;
  updatedAt: string;
}

export interface BudgetState {
  pk: string;
  runtimeSeconds: number;
  estimatedCostUsd: number;
  estimatedCostJpy: number;
  startCount: number;
  updatedAt: string;
}

export type OperationPhase = "CLAIMED" | "TASK_STARTED" | "SCHEDULED" | "ROLLED_BACK" | "SETTLED";

export interface StartOperation {
  pk: `OPERATION#${string}`;
  runId: string;
  mapId: string;
  phase: OperationPhase;
  taskArn: string | null;
  createdAt: string;
  updatedAt: string;
  ttl: number;
}
