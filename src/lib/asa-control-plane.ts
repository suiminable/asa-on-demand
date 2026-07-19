import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import type * as s3 from "aws-cdk-lib/aws-s3";

export interface AsaControlPlaneProps {
  rootDir: string;
  vpc: ec2.Vpc;
  serverSecurityGroup: ec2.SecurityGroup;
  stateBucket: s3.Bucket;
  cluster: ecs.Cluster;
  taskDefinition: ecs.FargateTaskDefinition;
  executionRole: iam.IRole;
  resourcePrefix: string;
  resourceNameSegment: string;
  discordFunctionName: string;
  configPrefix: string;
  parameterNames: Record<string, string>;
  secretNames: Record<string, string> & { notificationWebhookUrl: string };
  defaultIdleMinutes: number;
  heartbeatFreshnessSeconds: number;
  monthlyRuntimeHoursLimit: number;
  maxConcurrentMaps: number;
  monthlyBudgetJpy: number;
  hourlyCostJpy: number;
  spotHourlyCostJpy: number;
  jpyPerUsd: number;
  enableOnDemandFallback: boolean;
  allowDiscordPasswordNotification: boolean;
  hostedZoneId?: string;
  hostedZoneName?: string;
  domainName?: string;
  enableAwsBudget: boolean;
  budgetEmail?: string;
}

export interface AsaControlPlaneResources {
  api: apigwv2.HttpApi;
  stateTable: dynamodb.Table;
}

function prefixedLogGroupName(resourceNameSegment: string, suffix: string): string {
  return resourceNameSegment ? `/asa/${resourceNameSegment}/${suffix}` : `/asa/${suffix}`;
}

/** Creates the control plane directly under the Stack scope to preserve logical IDs. */
export function createAsaControlPlane(stack: cdk.Stack, props: AsaControlPlaneProps): AsaControlPlaneResources {
  const stateTable = new dynamodb.Table(stack, "AsaServerStateTable", {
    partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: "ttl",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  stateTable.addGlobalSecondaryIndex({
    indexName: "operations-by-phase",
    partitionKey: { name: "phase", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const stopSchedulerRole = new iam.Role(stack, "AsaStopSchedulerRole", {
    assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
  });

  const lambdaDefaults = {
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.X86_64,
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    bundling: {
      minify: true,
      sourceMap: true,
      target: "node22",
      format: lambdaNodejs.OutputFormat.ESM,
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
  } satisfies Partial<lambdaNodejs.NodejsFunctionProps>;

  const commonEnvironment = {
    TABLE_NAME: stateTable.tableName,
    CLUSTER_ARN: props.cluster.clusterArn,
    CLUSTER_NAME: props.cluster.clusterName,
    TASK_DEFINITION_ARN: props.taskDefinition.taskDefinitionArn,
    SUBNET_IDS: props.vpc.publicSubnets.map((subnet) => subnet.subnetId).join(","),
    SECURITY_GROUP_ID: props.serverSecurityGroup.securityGroupId,
    S3_BUCKET: props.stateBucket.bucketName,
    RESOURCE_PREFIX: props.resourcePrefix,
    ENVIRONMENT_NAME: props.resourceNameSegment || "default",
    CONFIG_PREFIX: props.configPrefix,
    STOP_SCHEDULER_ROLE_ARN: stopSchedulerRole.roleArn,
    DEFAULT_IDLE_MINUTES: String(props.defaultIdleMinutes),
    HEARTBEAT_FRESHNESS_SECONDS: String(props.heartbeatFreshnessSeconds),
    MONTHLY_RUNTIME_HOURS_LIMIT: String(props.monthlyRuntimeHoursLimit),
    MAX_CONCURRENT_MAPS: String(props.maxConcurrentMaps),
    MONTHLY_BUDGET_JPY: String(props.monthlyBudgetJpy),
    HOURLY_COST_JPY: String(props.hourlyCostJpy),
    SPOT_HOURLY_COST_JPY: String(props.spotHourlyCostJpy),
    JPY_PER_USD: String(props.jpyPerUsd),
    ENABLE_ON_DEMAND_FALLBACK: String(props.enableOnDemandFallback),
    ALLOW_DISCORD_PASSWORD_NOTIFICATION: String(props.allowDiscordPasswordNotification),
    DOMAIN_NAME: props.domainName ?? "",
  };

  const discordInteractionsLogGroup = new logs.LogGroup(stack, "DiscordInteractionsLogGroup", {
    logGroupName: prefixedLogGroupName(props.resourceNameSegment, "lambda/discord-interactions"),
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const discordInteractions = new lambdaNodejs.NodejsFunction(stack, "DiscordInteractionLambda", {
    ...lambdaDefaults,
    functionName: props.discordFunctionName,
    entry: path.join(props.rootDir, "src/lambdas/discord-interactions/index.ts"),
    logGroup: discordInteractionsLogGroup,
    environment: commonEnvironment,
  });
  discordInteractions.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [
        stack.formatArn({
          service: "lambda",
          resource: "function",
          resourceName: props.discordFunctionName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }),
  );

  const ecsTaskEventsLogGroup = new logs.LogGroup(stack, "EcsTaskEventsLogGroup", {
    logGroupName: prefixedLogGroupName(props.resourceNameSegment, "lambda/ecs-task-events"),
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const ecsTaskEvents = new lambdaNodejs.NodejsFunction(stack, "EcsTaskEventsLambda", {
    ...lambdaDefaults,
    entry: path.join(props.rootDir, "src/lambdas/ecs-task-events/index.ts"),
    logGroup: ecsTaskEventsLogGroup,
    environment: {
      ...commonEnvironment,
      NOTIFICATION_WEBHOOK_SECRET_NAME: props.secretNames.notificationWebhookUrl,
      HOSTED_ZONE_ID: props.hostedZoneId ?? "",
    },
  });

  const stopServerLogGroup = new logs.LogGroup(stack, "StopServerLogGroup", {
    logGroupName: prefixedLogGroupName(props.resourceNameSegment, "lambda/stop-server"),
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const stopServer = new lambdaNodejs.NodejsFunction(stack, "StopServerLambda", {
    ...lambdaDefaults,
    entry: path.join(props.rootDir, "src/lambdas/stop-server/index.ts"),
    logGroup: stopServerLogGroup,
    environment: {
      ...commonEnvironment,
      NOTIFICATION_WEBHOOK_SECRET_NAME: props.secretNames.notificationWebhookUrl,
    },
  });
  stopServer.grantInvoke(stopSchedulerRole);
  stopServer.grantInvoke(discordInteractions);
  discordInteractions.addEnvironment("STOP_SERVER_FUNCTION_ARN", stopServer.functionArn);

  const reconcileStartsLogGroup = new logs.LogGroup(stack, "ReconcileStartsLogGroup", {
    logGroupName: prefixedLogGroupName(props.resourceNameSegment, "lambda/reconcile-starts"),
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const reconcileStarts = new lambdaNodejs.NodejsFunction(stack, "ReconcileStartsLambda", {
    ...lambdaDefaults,
    entry: path.join(props.rootDir, "src/lambdas/reconcile-starts/index.ts"),
    logGroup: reconcileStartsLogGroup,
    environment: {
      ...commonEnvironment,
      STOP_SERVER_FUNCTION_ARN: stopServer.functionArn,
    },
  });
  new events.Rule(stack, "ReconcileStartsSchedule", {
    schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    targets: [new targets.LambdaFunction(reconcileStarts)],
  });

  const api = new apigwv2.HttpApi(stack, "AsaDiscordHttpApi");
  api.addRoutes({
    path: "/discord/interactions",
    methods: [apigwv2.HttpMethod.POST],
    integration: new integrations.HttpLambdaIntegration("DiscordInteractionsPostIntegration", discordInteractions),
  });

  new events.Rule(stack, "AsaTaskStateChangeRule", {
    eventPattern: {
      source: ["aws.ecs"],
      detailType: ["ECS Task State Change"],
      detail: { clusterArn: [props.cluster.clusterArn] },
    },
    targets: [new targets.LambdaFunction(ecsTaskEvents)],
  });

  stateTable.grantReadWriteData(discordInteractions);
  stateTable.grantReadWriteData(ecsTaskEvents);
  stateTable.grantReadWriteData(stopServer);
  stateTable.grantReadWriteData(reconcileStarts);
  props.stateBucket.grantPut(discordInteractions, `${props.resourcePrefix}maps/*/runtime/*`);
  props.stateBucket.grantRead(discordInteractions, `${props.resourcePrefix}maps/*/runtime/*`);
  props.stateBucket.grantRead(stopServer, `${props.resourcePrefix}maps/*/runtime/*`);
  props.stateBucket.grantRead(ecsTaskEvents, `${props.resourcePrefix}maps/*/runtime/*`);

  for (const fn of [discordInteractions, stopServer]) {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks", "ecs:StopTask"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": props.cluster.clusterArn } },
      }),
    );
  }
  discordInteractions.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: [props.taskDefinition.taskDefinitionArn],
      conditions: { ArnEquals: { "ecs:cluster": props.cluster.clusterArn } },
    }),
  );
  reconcileStarts.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ecs:ListTasks", "ecs:DescribeTasks"],
      resources: ["*"],
      conditions: { ArnEquals: { "ecs:cluster": props.cluster.clusterArn } },
    }),
  );
  discordInteractions.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [props.taskDefinition.taskRole.roleArn, props.executionRole.roleArn],
    }),
  );

  const scheduleArn = `arn:${cdk.Aws.PARTITION}:scheduler:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:schedule/default/asa-${props.resourceNameSegment || "default"}-*-auto-stop`;
  reconcileStarts.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
      resources: [scheduleArn],
    }),
  );
  reconcileStarts.addToRolePolicy(new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [stopSchedulerRole.roleArn] }));
  discordInteractions.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
      resources: [scheduleArn],
    }),
  );
  discordInteractions.addToRolePolicy(new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [stopSchedulerRole.roleArn] }));
  stopServer.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["scheduler:DeleteSchedule", "scheduler:GetSchedule"],
      resources: [scheduleArn],
    }),
  );
  ecsTaskEvents.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ecs:DescribeTasks", "ec2:DescribeNetworkInterfaces"],
      resources: ["*"],
    }),
  );
  ecsTaskEvents.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["scheduler:DeleteSchedule"],
      resources: [scheduleArn],
    }),
  );

  for (const fn of [discordInteractions, ecsTaskEvents, stopServer]) {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: Object.values(props.parameterNames).map(
          (name) => `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${name}`,
        ),
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: Object.values(props.secretNames).map(
          (name) => `arn:${cdk.Aws.PARTITION}:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${name}*`,
        ),
      }),
    );
  }

  if (props.hostedZoneId && props.domainName) {
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "AsaHostedZone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName as string,
    });
    ecsTaskEvents.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["route53:ChangeResourceRecordSets"], resources: [zone.hostedZoneArn] }),
    );
  }

  if (props.enableAwsBudget) {
    if (!props.budgetEmail) throw new Error("budgetEmail context is required when enableAwsBudget=true.");
    new budgets.CfnBudget(stack, "AsaMonthlyBudget", {
      budget: {
        budgetName: props.resourcePrefix ? `asa-on-demand-${props.resourceNameSegment}-monthly-budget` : "asa-on-demand-monthly-budget",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetJpy / props.jpyPerUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.budgetEmail }],
        },
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.budgetEmail }],
        },
      ],
    });
  }

  return { api, stateTable };
}
