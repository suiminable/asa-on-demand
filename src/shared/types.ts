export type ServerStatus = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";

export interface ServerState {
  pk: "SERVER";
  status: ServerStatus;
  taskArn?: string | null;
  clusterArn?: string | null;
  startedAt?: string | null;
  expiresAt?: string | null;
  publicIp?: string | null;
  connectCommand?: string | null;
  sessionName: string;
  mapName: string;
  maxPlayers: number;
  startedByDiscordUserId?: string | null;
  startedFromChannelId?: string | null;
  lastBackupAt?: string | null;
  lastStopReason?: string | null;
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

