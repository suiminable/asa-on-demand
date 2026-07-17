import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { BudgetState, ServerState, ServerStatus } from "./types.js";

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

export class StateStore {
  constructor(private readonly tableName: string) {}

  async getServer(): Promise<ServerState | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: "SERVER" } }));
    return result.Item as ServerState | undefined;
  }

  async getBudget(pk: string): Promise<BudgetState | undefined> {
    const result = await documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk } }));
    return result.Item as BudgetState | undefined;
  }

  async putServerStarting(state: ServerState, staleBefore: string): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: state,
        ConditionExpression:
          "attribute_not_exists(pk) OR #status IN (:stopped, :error) OR (#status = :starting AND (attribute_not_exists(#taskArn) OR #taskArn = :null) AND #updatedAt < :staleBefore)",
        ExpressionAttributeNames: { "#status": "status", "#taskArn": "taskArn", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: {
          ":stopped": "STOPPED",
          ":error": "ERROR",
          ":starting": "STARTING",
          ":null": null,
          ":staleBefore": staleBefore,
        },
      }),
    );
  }

  async settleStoppedTask(params: { taskArn: string; budgets: BudgetSettlement[]; reason: string }): Promise<boolean> {
    const now = new Date().toISOString();
    if (params.budgets.length > 98) throw new Error("A task settlement cannot span more than 98 budget months.");
    try {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { pk: `TASK_SETTLEMENT#${params.taskArn}`, taskArn: params.taskArn, settledAt: now },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            ...params.budgets.map((budget) => ({
              Update: {
                TableName: this.tableName,
                Key: { pk: budget.budgetPk },
                UpdateExpression:
                  "ADD runtimeSeconds :runtimeSeconds, estimatedCostJpy :estimatedCostJpy, estimatedCostUsd :estimatedCostUsd SET updatedAt = :updatedAt, startCount = if_not_exists(startCount, :zero)",
                ExpressionAttributeValues: {
                  ":runtimeSeconds": budget.runtimeSeconds,
                  ":estimatedCostJpy": budget.estimatedCostJpy,
                  ":estimatedCostUsd": budget.estimatedCostUsd,
                  ":updatedAt": now,
                  ":zero": 0,
                },
              },
            })),
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: "SERVER" },
                UpdateExpression:
                  "SET #status = :stopped, #updatedAt = :updatedAt, taskArn = :null, taskStartedAt = :null, publicIp = :null, connectCommand = :null, idleSince = :null, lastHeartbeatAt = :null, lastStopReason = :reason",
                ConditionExpression: "taskArn = :taskArn",
                ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
                ExpressionAttributeValues: {
                  ":stopped": "STOPPED",
                  ":updatedAt": now,
                  ":null": null,
                  ":reason": params.reason,
                  ":taskArn": params.taskArn,
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (errorName(error) === "TransactionCanceledException") return false;
      throw error;
    }
  }

  async updateServerStatus(status: ServerStatus, values: Partial<ServerState> = {}): Promise<void> {
    const now = new Date().toISOString();
    const names: Record<string, string> = { "#status": "status", "#updatedAt": "updatedAt" };
    const attrValues: Record<string, unknown> = { ":status": status, ":updatedAt": now };
    const sets = ["#status = :status", "#updatedAt = :updatedAt"];
    let index = 0;
    for (const [key, value] of Object.entries(values)) {
      index += 1;
      names[`#k${index}`] = key;
      attrValues[`:v${index}`] = value;
      sets.push(`#k${index} = :v${index}`);
    }
    await documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: "SERVER" },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: attrValues,
      }),
    );
  }

  async updateRunningIdleState(taskArn: string, values: { idleSince: string | null; lastHeartbeatAt: string | null }): Promise<boolean> {
    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: "SERVER" },
          UpdateExpression: "SET idleSince = :idleSince, lastHeartbeatAt = :lastHeartbeatAt, #updatedAt = :updatedAt",
          ConditionExpression: "#status = :running AND taskArn = :taskArn",
          ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: {
            ":idleSince": values.idleSince,
            ":lastHeartbeatAt": values.lastHeartbeatAt,
            ":updatedAt": new Date().toISOString(),
            ":running": "RUNNING",
            ":taskArn": taskArn,
          },
        }),
      );
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async incrementStartCount(pk: string): Promise<void> {
    await documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk },
        UpdateExpression:
          "ADD startCount :one SET runtimeSeconds = if_not_exists(runtimeSeconds, :zero), estimatedCostUsd = if_not_exists(estimatedCostUsd, :zero), estimatedCostJpy = if_not_exists(estimatedCostJpy, :zero), updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":updatedAt": new Date().toISOString() },
      }),
    );
  }
}
