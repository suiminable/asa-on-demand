import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mapStatePk } from "./resources.js";
import type { BudgetState, ClusterState, MapServerState, ServerState, ServerStatus, StartOperation } from "./types.js";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error ? String(error.name) : undefined;
}

export interface BudgetSettlement {
  budgetPk: string;
  runtimeSeconds: number;
  estimatedCostJpy: number;
  estimatedCostUsd: number;
}

function canceled(error: unknown): boolean {
  return errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException";
}

export class StateStore {
  constructor(private readonly tableName: string) {}

  /** v1 migration source only. New control-plane code must not update this row. */
  async getServer(): Promise<ServerState | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: "SERVER" } }));
    return result.Item as ServerState | undefined;
  }

  async getMap(mapId: string): Promise<MapServerState | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: mapStatePk(mapId) } }));
    return result.Item as MapServerState | undefined;
  }

  async getMaps(mapIds: string[]): Promise<MapServerState[]> {
    if (mapIds.length === 0) return [];
    const result = await documentClient.send(
      new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: mapIds.map((mapId) => ({ pk: mapStatePk(mapId) })) } } }),
    );
    return (result.Responses?.[this.tableName] ?? []) as MapServerState[];
  }

  async getCluster(): Promise<ClusterState | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: "CLUSTER" } }));
    return result.Item as ClusterState | undefined;
  }

  async getStaleOperations(phases: Array<StartOperation["phase"]>, before: string): Promise<StartOperation[]> {
    const operations: StartOperation[] = [];
    for (const phase of phases) {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            IndexName: "operations-by-phase",
            KeyConditionExpression: "phase = :phase AND updatedAt < :before",
            ExpressionAttributeValues: { ":phase": phase, ":before": before },
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          }),
        );
        operations.push(...((page.Items ?? []) as StartOperation[]));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey);
    }
    return [...new Map(operations.map((operation) => [operation.pk, operation])).values()];
  }

  async getBudget(pk: string): Promise<BudgetState | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk } }));
    return result.Item as BudgetState | undefined;
  }

  async claimMapStart(params: {
    state: MapServerState;
    operation: StartOperation;
    maxConcurrentMaps: number;
    budgetPk: string;
    schemaVersion: number;
  }): Promise<boolean> {
    const now = params.state.updatedAt;
    try {
      await documentClient.send(
        new TransactWriteCommand({
          ClientRequestToken: params.operation.runId,
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: params.state,
                ConditionExpression: "attribute_not_exists(pk) OR #status IN (:stopped, :error)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":stopped": "STOPPED", ":error": "ERROR" },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: "CLUSTER" },
                UpdateExpression:
                  "SET activeCount = if_not_exists(activeCount, :zero) + :one, maxConcurrentMaps = :max, schemaVersion = :schema, updatedAt = :updatedAt",
                ConditionExpression:
                  "(attribute_not_exists(activeCount) OR activeCount < :max) AND (attribute_not_exists(schemaVersion) OR schemaVersion = :schema)",
                ExpressionAttributeValues: {
                  ":zero": 0,
                  ":one": 1,
                  ":max": params.maxConcurrentMaps,
                  ":schema": params.schemaVersion,
                  ":updatedAt": now,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: params.budgetPk },
                UpdateExpression:
                  "SET runtimeSeconds = if_not_exists(runtimeSeconds, :zero), estimatedCostUsd = if_not_exists(estimatedCostUsd, :zero), estimatedCostJpy = if_not_exists(estimatedCostJpy, :zero), updatedAt = :updatedAt ADD startCount :one",
                ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":updatedAt": now },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: params.operation,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async attachStartedTask(mapId: string, runId: string, taskArn: string): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: mapStatePk(mapId) },
                UpdateExpression: "SET taskArn = :taskArn, #updatedAt = :now",
                ConditionExpression:
                  "runId = :runId AND #status IN (:starting, :running) AND (attribute_not_exists(taskArn) OR taskArn = :null OR taskArn = :taskArn)",
                ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: {
                  ":runId": runId,
                  ":starting": "STARTING",
                  ":running": "RUNNING",
                  ":taskArn": taskArn,
                  ":null": null,
                  ":now": now,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: `OPERATION#${runId}` },
                UpdateExpression: "SET phase = :phase, taskArn = :taskArn, updatedAt = :now",
                ConditionExpression: "runId = :runId AND mapId = :mapId AND phase IN (:claimed, :started)",
                ExpressionAttributeValues: {
                  ":phase": "TASK_STARTED",
                  ":taskArn": taskArn,
                  ":now": now,
                  ":runId": runId,
                  ":mapId": mapId,
                  ":claimed": "CLAIMED",
                  ":started": "TASK_STARTED",
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async markOperationScheduled(runId: string, mapId: string, taskArn: string): Promise<boolean> {
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `OPERATION#${runId}` },
          UpdateExpression: "SET phase = :scheduled, updatedAt = :now",
          ConditionExpression: "runId = :runId AND mapId = :mapId AND taskArn = :taskArn AND phase IN (:started, :scheduled)",
          ExpressionAttributeValues: {
            ":scheduled": "SCHEDULED",
            ":started": "TASK_STARTED",
            ":runId": runId,
            ":mapId": mapId,
            ":taskArn": taskArn,
            ":now": new Date().toISOString(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async rollbackMapStart(mapId: string, runId: string, reason: string): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: mapStatePk(mapId) },
                UpdateExpression:
                  "SET #status = :error, taskArn = :null, runId = :null, taskStartedAt = :null, publicIp = :null, connectCommand = :null, idleSince = :null, lastHeartbeatAt = :null, lastStopReason = :reason, #updatedAt = :now",
                ConditionExpression: "runId = :runId AND #status IN (:starting, :running, :stopping)",
                ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: {
                  ":error": "ERROR",
                  ":starting": "STARTING",
                  ":running": "RUNNING",
                  ":stopping": "STOPPING",
                  ":null": null,
                  ":reason": reason,
                  ":now": now,
                  ":runId": runId,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: "CLUSTER" },
                UpdateExpression: "ADD activeCount :minusOne SET updatedAt = :now",
                ConditionExpression: "activeCount > :zero",
                ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0, ":now": now },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: `OPERATION#${runId}` },
                UpdateExpression: "SET phase = :rolledBack, updatedAt = :now",
                ConditionExpression: "mapId = :mapId AND phase <> :rolledBack AND phase <> :settled",
                ExpressionAttributeValues: {
                  ":rolledBack": "ROLLED_BACK",
                  ":settled": "SETTLED",
                  ":mapId": mapId,
                  ":now": now,
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async updateMapFromRunningEvent(params: {
    mapId: string;
    runId: string;
    taskArn: string;
    eventVersion: number;
    clusterArn: string;
    taskStartedAt: string;
    publicIp: string | null;
    connectCommand: string | null;
  }): Promise<MapServerState | undefined> {
    try {
      const result = await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: mapStatePk(params.mapId) },
          UpdateExpression:
            "SET #status = :running, taskArn = :taskArn, clusterArn = :clusterArn, taskStartedAt = :startedAt, publicIp = :publicIp, connectCommand = :connect, lastEcsEventVersion = :version, #updatedAt = :now",
          ConditionExpression:
            "runId = :runId AND (attribute_not_exists(taskArn) OR taskArn = :null OR taskArn = :taskArn) AND (attribute_not_exists(lastEcsEventVersion) OR lastEcsEventVersion = :null OR lastEcsEventVersion < :version)",
          ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: {
            ":running": "RUNNING",
            ":runId": params.runId,
            ":taskArn": params.taskArn,
            ":clusterArn": params.clusterArn,
            ":startedAt": params.taskStartedAt,
            ":publicIp": params.publicIp,
            ":connect": params.connectCommand,
            ":version": params.eventVersion,
            ":null": null,
            ":now": new Date().toISOString(),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return result.Attributes as MapServerState | undefined;
    } catch (error) {
      if (canceled(error)) return undefined;
      throw error;
    }
  }

  async updateRunningConnectCommand(params: {
    mapId: string;
    runId: string;
    taskArn: string;
    eventVersion: number;
    connectCommand: string;
  }): Promise<boolean> {
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: mapStatePk(params.mapId) },
          UpdateExpression: "SET connectCommand = :connect, #updatedAt = :now",
          ConditionExpression: "#status = :running AND runId = :runId AND taskArn = :taskArn AND lastEcsEventVersion = :version",
          ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: {
            ":running": "RUNNING",
            ":runId": params.runId,
            ":taskArn": params.taskArn,
            ":version": params.eventVersion,
            ":connect": params.connectCommand,
            ":now": new Date().toISOString(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async markMapStopping(mapId: string, runId: string, taskArn: string, reason: string): Promise<boolean> {
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: mapStatePk(mapId) },
          UpdateExpression: "SET #status = :stopping, lastStopReason = :reason, #updatedAt = :now",
          ConditionExpression: "runId = :runId AND taskArn = :taskArn AND #status IN (:starting, :running, :stopping)",
          ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: {
            ":runId": runId,
            ":taskArn": taskArn,
            ":reason": reason,
            ":starting": "STARTING",
            ":running": "RUNNING",
            ":stopping": "STOPPING",
            ":now": new Date().toISOString(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async settleStoppedMapTask(params: {
    mapId: string;
    runId: string;
    taskArn: string;
    budgets: BudgetSettlement[];
    reason: string;
    eventVersion: number;
    lastBackupAt?: string | null;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const pks = new Set(params.budgets.map((value) => value.budgetPk));
    if (pks.size > 20) throw new Error("A task settlement cannot span more than 20 budget months.");
    const actualByPk = new Map(params.budgets.map((value) => [value.budgetPk, value]));
    try {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { pk: `TASK_SETTLEMENT#${params.taskArn}`, taskArn: params.taskArn, runId: params.runId, settledAt: now },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            ...[...pks].map((pk) => {
              const actual = actualByPk.get(pk);
              return {
                Update: {
                  TableName: this.tableName,
                  Key: { pk },
                  UpdateExpression:
                    "SET updatedAt = :now, startCount = if_not_exists(startCount, :zero) ADD runtimeSeconds :actual, estimatedCostJpy :costJpy, estimatedCostUsd :costUsd",
                  ExpressionAttributeValues: {
                    ":actual": actual?.runtimeSeconds ?? 0,
                    ":costJpy": actual?.estimatedCostJpy ?? 0,
                    ":costUsd": actual?.estimatedCostUsd ?? 0,
                    ":zero": 0,
                    ":now": now,
                  },
                },
              };
            }),
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: mapStatePk(params.mapId) },
                UpdateExpression:
                  "SET #status = :stopped, #updatedAt = :now, taskArn = :null, runId = :null, taskStartedAt = :null, publicIp = :null, connectCommand = :null, idleSince = :null, lastHeartbeatAt = :null, lastStopReason = :reason, lastEcsEventVersion = :version, lastBackupAt = :lastBackupAt",
                ConditionExpression:
                  "runId = :runId AND taskArn = :taskArn AND (attribute_not_exists(lastEcsEventVersion) OR lastEcsEventVersion = :null OR lastEcsEventVersion < :version)",
                ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: {
                  ":stopped": "STOPPED",
                  ":now": now,
                  ":null": null,
                  ":reason": params.reason,
                  ":version": params.eventVersion,
                  ":lastBackupAt": params.lastBackupAt ?? null,
                  ":runId": params.runId,
                  ":taskArn": params.taskArn,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: "CLUSTER" },
                UpdateExpression: "ADD activeCount :minusOne SET updatedAt = :now",
                ConditionExpression: "activeCount > :zero",
                ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0, ":now": now },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: `OPERATION#${params.runId}` },
                UpdateExpression: "SET phase = :settled, updatedAt = :now",
                ConditionExpression: "mapId = :mapId AND taskArn = :taskArn AND phase <> :settled",
                ExpressionAttributeValues: {
                  ":settled": "SETTLED",
                  ":mapId": params.mapId,
                  ":taskArn": params.taskArn,
                  ":now": now,
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async updateRunningIdleState(
    mapId: string,
    runId: string,
    taskArn: string,
    values: { idleSince: string | null; lastHeartbeatAt: string | null },
  ): Promise<boolean> {
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: mapStatePk(mapId) },
          UpdateExpression: "SET idleSince = :idleSince, lastHeartbeatAt = :lastHeartbeatAt, #updatedAt = :updatedAt",
          ConditionExpression: "#status = :running AND runId = :runId AND taskArn = :taskArn",
          ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: {
            ":idleSince": values.idleSince,
            ":lastHeartbeatAt": values.lastHeartbeatAt,
            ":updatedAt": new Date().toISOString(),
            ":running": "RUNNING",
            ":runId": runId,
            ":taskArn": taskArn,
          },
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }

  async updateMapStatus(mapId: string, runId: string, status: ServerStatus, values: Partial<MapServerState> = {}): Promise<boolean> {
    const names: Record<string, string> = { "#status": "status", "#updatedAt": "updatedAt" };
    const attrValues: Record<string, unknown> = { ":status": status, ":updatedAt": new Date().toISOString(), ":runId": runId };
    const sets = ["#status = :status", "#updatedAt = :updatedAt"];
    let index = 0;
    for (const [key, value] of Object.entries(values)) {
      index += 1;
      names[`#k${index}`] = key;
      attrValues[`:v${index}`] = value;
      sets.push(`#k${index} = :v${index}`);
    }
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: mapStatePk(mapId) },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "runId = :runId",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: attrValues,
        }),
      );
      return true;
    } catch (error) {
      if (canceled(error)) return false;
      throw error;
    }
  }
}
