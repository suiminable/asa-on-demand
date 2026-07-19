import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { requireEnv } from "../../shared/config.js";
import { stopScheduleName } from "../../shared/resources.js";
import { StateStore } from "../../shared/state.js";
import type { MapServerState, StartOperation } from "../../shared/types.js";

const ecs = new ECSClient({});
const scheduler = new SchedulerClient({});
const store = new StateStore(requireEnv("TABLE_NAME"));
const clusterArn = requireEnv("CLUSTER_ARN");
const environmentName = process.env.ENVIRONMENT_NAME ?? "default";
const stopSchedulerRoleArn = requireEnv("STOP_SCHEDULER_ROLE_ARN");
const stopFunctionArn = requireEnv("STOP_SERVER_FUNCTION_ARN");

async function taskFor(operation: StartOperation, knownTaskArn?: string | null): Promise<string | undefined> {
  const candidateArn = knownTaskArn ?? operation.taskArn;
  if (candidateArn) {
    const described = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [candidateArn] }));
    const task = described.tasks?.[0];
    if (
      task?.group === `asa-map:${operation.mapId}:${operation.runId}` &&
      (task.lastStatus === "RUNNING" || task.lastStatus === "PENDING")
    ) {
      return candidateArn;
    }
  }
  for (const desiredStatus of ["RUNNING", "PENDING"] as const) {
    const listed = await ecs.send(new ListTasksCommand({ cluster: clusterArn, startedBy: operation.runId, desiredStatus }));
    const taskArn = listed.taskArns?.[0];
    if (!taskArn) continue;
    const described = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] }));
    if (described.tasks?.[0]?.group === `asa-map:${operation.mapId}:${operation.runId}`) return taskArn;
  }
  return undefined;
}

async function ensureSchedule(state: MapServerState, taskArn: string): Promise<void> {
  const name = stopScheduleName(environmentName, state.mapId);
  await scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: "default" })).catch(() => undefined);
  await scheduler.send(
    new CreateScheduleCommand({
      Name: name,
      GroupName: "default",
      FlexibleTimeWindow: { Mode: "OFF" },
      ScheduleExpression: "rate(1 minute)",
      Target: {
        Arn: stopFunctionArn,
        RoleArn: stopSchedulerRoleArn,
        Input: JSON.stringify({ source: "IDLE_CHECK", mapId: state.mapId, runId: state.runId, expectedTaskArn: taskArn }),
      },
    }),
  );
}

async function stoppingTaskStillExists(operation: StartOperation, state: MapServerState): Promise<boolean> {
  const taskArn = state.taskArn ?? operation.taskArn;
  if (!taskArn) return false;
  const described = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] }));
  const task = described.tasks?.[0];
  return Boolean(
    task?.group === `asa-map:${operation.mapId}:${operation.runId}` && typeof task.lastStatus === "string" && task.lastStatus !== "STOPPED",
  );
}

async function reconcile(operation: StartOperation): Promise<void> {
  const state = await store.getMap(operation.mapId);
  if (
    !state ||
    state.runId !== operation.runId ||
    (state.status !== "STARTING" && state.status !== "RUNNING" && state.status !== "STOPPING")
  )
    return;
  if (state.status === "STOPPING") {
    if (await stoppingTaskStillExists(operation, state)) return;
    await store.rollbackMapStart(operation.mapId, operation.runId, "STALE_STOPPING_START_RECONCILED");
    return;
  }
  const taskArn = await taskFor(operation, state.taskArn);
  if (!taskArn) {
    await store.rollbackMapStart(operation.mapId, operation.runId, "STALE_START_RECONCILED");
    return;
  }
  if (!(await store.attachStartedTask(operation.mapId, operation.runId, taskArn))) return;
  state.taskArn = taskArn;
  await ensureSchedule(state, taskArn);
  await store.markOperationScheduled(operation.runId, operation.mapId, taskArn);
}

export async function handler(): Promise<void> {
  const before = new Date(Date.now() - 5 * 60_000).toISOString();
  const operations = await store.getStaleOperations(["CLAIMED", "TASK_STARTED"], before);
  await Promise.all(operations.map(reconcile));
}
