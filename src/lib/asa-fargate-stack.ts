import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { normalizeConfigPrefix, parameterNamesFor, secretNamesFor } from "../shared/config.js";
import { DEFAULT_SESSION_HOURS, MAX_SESSION_HOURS } from "../shared/defaults.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "../..");

interface NumberContext {
  name: string;
  defaultValue: number;
}

function numberContext(scope: Construct, props: NumberContext): number {
  const value = scope.node.tryGetContext(props.name);
  if (value === undefined || value === null || value === "") return props.defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Context ${props.name} must be a number.`);
  return parsed;
}

function booleanContext(scope: Construct, name: string, defaultValue: boolean): boolean {
  const value = scope.node.tryGetContext(name);
  if (value === undefined || value === null || value === "") return defaultValue;
  return value === true || value === "true";
}

function stringContext(scope: Construct, name: string, defaultValue = ""): string {
  const value = scope.node.tryGetContext(name);
  if (value === undefined || value === null) return defaultValue;
  return String(value);
}

function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (!/^[A-Za-z0-9_./-]+$/.test(trimmed)) {
    throw new Error("Context resourcePrefix must contain only letters, numbers, slash, dot, underscore, or hyphen.");
  }
  return `${trimmed}/`;
}

function normalizeNameSegment(value: string, fallback = "default"): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

function s3Key(scopePrefix: string, key: string): string {
  return `${scopePrefix}${key}`;
}

function s3Pattern(scopePrefix: string, pattern: string): string {
  return `${scopePrefix}${pattern}`;
}

function prefixedLogGroupName(resourceNameSegment: string, suffix: string): string {
  return resourceNameSegment ? `/asa/${resourceNameSegment}/${suffix}` : `/asa/${suffix}`;
}

export class AsaFargateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = this.node.tryGetContext("region") ?? cdk.Stack.of(this).region;
    const resourcePrefix = normalizeS3Prefix(stringContext(this, "resourcePrefix"));
    const resourceNameSegment = resourcePrefix ? normalizeNameSegment(resourcePrefix) : "";
    const environmentId = resourcePrefix || "default";
    const environmentHash = createHash("sha256").update(environmentId).digest("hex").slice(0, 8);
    const discordFunctionName = `asa-${(resourceNameSegment || "default").slice(0, 42)}-discord-${environmentHash}`;
    const configPrefix = normalizeConfigPrefix(resourcePrefix ? `/asa/${resourcePrefix}` : "/asa");
    const parameterNames = parameterNamesFor(configPrefix);
    const secretNames = secretNamesFor(configPrefix);
    const cpu = numberContext(this, { name: "asaCpu", defaultValue: 2048 });
    const memoryMiB = numberContext(this, { name: "asaMemoryMiB", defaultValue: 16384 });
    const ephemeralStorageGiB = numberContext(this, { name: "asaEphemeralStorageGiB", defaultValue: 100 });
    const stopTimeoutSeconds = numberContext(this, { name: "asaStopTimeoutSeconds", defaultValue: 120 });
    const defaultSessionHours = numberContext(this, { name: "defaultSessionHours", defaultValue: DEFAULT_SESSION_HOURS });
    const maxSessionHours = numberContext(this, { name: "maxSessionHours", defaultValue: MAX_SESSION_HOURS });
    const monthlyBudgetJpy = numberContext(this, { name: "monthlyBudgetJpy", defaultValue: 1500 });
    const hourlyCostJpy = numberContext(this, { name: "hourlyCostJpy", defaultValue: 18.75 });
    const jpyPerUsd = numberContext(this, { name: "jpyPerUsd", defaultValue: 150 });
    const monthlyRuntimeHoursLimit = numberContext(this, { name: "monthlyRuntimeHoursLimit", defaultValue: 80 });
    const enableOnDemandFallback = booleanContext(this, "enableOnDemandFallback", false);
    const allowDiscordPasswordNotification = booleanContext(this, "allowDiscordPasswordNotification", false);
    const asaBuildId = stringContext(this, "asaBuildId") || "initial";
    const asaUpdateOnStart = booleanContext(this, "asaUpdateOnStart", false);
    const asaClusterId = stringContext(this, "asaClusterId") || resourceNameSegment || "asa-on-demand";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(asaClusterId)) {
      throw new Error("Context asaClusterId must contain only letters, numbers, dot, underscore, or hyphen.");
    }
    const enableAwsBudget = booleanContext(this, "enableAwsBudget", false);
    const budgetEmail = this.node.tryGetContext("budgetEmail") as string | undefined;
    const hostedZoneId = this.node.tryGetContext("hostedZoneId") as string | undefined;
    const hostedZoneName = this.node.tryGetContext("hostedZoneName") as string | undefined;
    const domainName = this.node.tryGetContext("domainName") as string | undefined;
    const vpc = new ec2.Vpc(this, "AsaVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const serverSecurityGroup = new ec2.SecurityGroup(this, "AsaServerSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      disableInlineRules: true,
      description: "ASA Fargate task security group",
    });
    serverSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(7777), "ASA game port");
    serverSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(7778), "ASA adjacent UDP port");

    const stateBucket = new s3.Bucket(this, "AsaStateBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { prefix: s3Key(resourcePrefix, "backups/"), expiration: cdk.Duration.days(30) },
        { prefix: s3Key(resourcePrefix, "logs/"), expiration: cdk.Duration.days(14) },
      ],
    });

    const stateTable = new dynamodb.Table(this, "AsaServerStateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const cluster = new ecs.Cluster(this, "AsaCluster", {
      vpc,
    });
    cluster.enableFargateCapacityProviders();

    const imageAsset = new ecrAssets.DockerImageAsset(this, "AsaServerImage", {
      directory: path.join(rootDir, "container"),
      buildArgs: { ASA_BUILD_ID: asaBuildId },
    });

    const ecsLogGroup = new logs.LogGroup(this, "AsaEcsLogGroup", {
      logGroupName: prefixedLogGroupName(resourceNameSegment, "ecs/server"),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const notificationWebhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "NotificationWebhookSecret",
      secretNames.notificationWebhookUrl,
    );
    const serverPasswordSecret = secretsmanager.Secret.fromSecretNameV2(this, "ServerPasswordSecret", secretNames.serverPassword);
    const adminPasswordSecret = secretsmanager.Secret.fromSecretNameV2(this, "ServerAdminPasswordSecret", secretNames.serverAdminPassword);

    const taskDefinition = new ecs.FargateTaskDefinition(this, "AsaTaskDefinition", {
      cpu,
      memoryLimitMiB: memoryMiB,
      ephemeralStorageGiB,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    taskDefinition.addContainer("AsaServerContainer", {
      image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
      essential: true,
      stopTimeout: cdk.Duration.seconds(stopTimeoutSeconds),
      healthCheck: {
        command: ["CMD-SHELL", "/asa/scripts/healthcheck.sh"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.minutes(10),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: ecsLogGroup,
        streamPrefix: "asa",
      }),
      portMappings: [
        { containerPort: 7777, protocol: ecs.Protocol.UDP },
        { containerPort: 7778, protocol: ecs.Protocol.UDP },
      ],
      environment: {
        AWS_REGION: region,
        S3_BUCKET: stateBucket.bucketName,
        S3_SAVE_KEY: s3Key(resourcePrefix, "saves/current.tar.zst"),
        S3_BACKUP_PREFIX: s3Key(resourcePrefix, "backups/"),
        S3_CONFIG_PREFIX: s3Key(resourcePrefix, "config/"),
        S3_RUNTIME_PREFIX: s3Key(resourcePrefix, "runtime/"),
        ASA_APP_ID: "2430930",
        ASA_INSTALL_DIR: "/asa/server",
        ASA_MAP: "TheIsland_WP",
        ASA_SESSION_NAME: "private-asa",
        ASA_MAX_PLAYERS: "4",
        ASA_PORT: "7777",
        ASA_RCON_PORT: "27020",
        ASA_CLUSTER_ID: asaClusterId,
        ASA_DISABLE_BATTLEYE: "true",
        ASA_UPDATE_ON_START: String(asaUpdateOnStart),
        AUTO_BACKUP_INTERVAL_SECONDS: "600",
        BACKUP_REQUEST_KEY: s3Key(resourcePrefix, "runtime/backup-request.json"),
      },
      secrets: {
        DISCORD_WEBHOOK_URL: ecs.Secret.fromSecretsManager(notificationWebhookSecret),
        ASA_SERVER_PASSWORD: ecs.Secret.fromSecretsManager(serverPasswordSecret),
        ASA_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPasswordSecret),
      },
    });

    const executionRole = taskDefinition.executionRole;
    if (!executionRole) throw new Error("Fargate task definition is missing an execution role.");

    imageAsset.repository.grantPull(executionRole);
    notificationWebhookSecret.grantRead(executionRole);
    serverPasswordSecret.grantRead(executionRole);
    adminPasswordSecret.grantRead(executionRole);

    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [stateBucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": [
              s3Pattern(resourcePrefix, "config/*"),
              s3Pattern(resourcePrefix, "saves/*"),
              s3Pattern(resourcePrefix, "runtime/*"),
              s3Pattern(resourcePrefix, "backups/*"),
            ],
          },
        },
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "config/*")),
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "saves/*")),
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "runtime/*")),
        ],
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "saves/*")),
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "backups/*")),
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "runtime/*")),
          stateBucket.arnForObjects(s3Pattern(resourcePrefix, "logs/*")),
        ],
      }),
    );

    const stopSchedulerRole = new iam.Role(this, "AsaStopSchedulerRole", {
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
      CLUSTER_ARN: cluster.clusterArn,
      CLUSTER_NAME: cluster.clusterName,
      TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
      SUBNET_IDS: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(","),
      SECURITY_GROUP_ID: serverSecurityGroup.securityGroupId,
      S3_BUCKET: stateBucket.bucketName,
      S3_RUNTIME_PREFIX: s3Key(resourcePrefix, "runtime/"),
      CONFIG_PREFIX: configPrefix,
      STOP_SCHEDULE_NAME: resourcePrefix ? `asa-${resourceNameSegment}-auto-stop` : "asa-auto-stop",
      STOP_SCHEDULER_ROLE_ARN: stopSchedulerRole.roleArn,
      DEFAULT_SESSION_HOURS: String(defaultSessionHours),
      MAX_SESSION_HOURS: String(maxSessionHours),
      MONTHLY_RUNTIME_HOURS_LIMIT: String(monthlyRuntimeHoursLimit),
      MONTHLY_BUDGET_JPY: String(monthlyBudgetJpy),
      HOURLY_COST_JPY: String(hourlyCostJpy),
      JPY_PER_USD: String(jpyPerUsd),
      ENABLE_ON_DEMAND_FALLBACK: String(enableOnDemandFallback),
      ALLOW_DISCORD_PASSWORD_NOTIFICATION: String(allowDiscordPasswordNotification),
      DOMAIN_NAME: domainName ?? "",
    };

    const discordInteractionsLogGroup = new logs.LogGroup(this, "DiscordInteractionsLogGroup", {
      logGroupName: prefixedLogGroupName(resourceNameSegment, "lambda/discord-interactions"),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const discordInteractions = new lambdaNodejs.NodejsFunction(this, "DiscordInteractionLambda", {
      ...lambdaDefaults,
      functionName: discordFunctionName,
      entry: path.join(rootDir, "src/lambdas/discord-interactions/index.ts"),
      logGroup: discordInteractionsLogGroup,
      environment: commonEnvironment,
    });
    discordInteractions.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [this.formatArn({ service: "lambda", resource: "function", resourceName: discordFunctionName })],
      }),
    );

    const ecsTaskEventsLogGroup = new logs.LogGroup(this, "EcsTaskEventsLogGroup", {
      logGroupName: prefixedLogGroupName(resourceNameSegment, "lambda/ecs-task-events"),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ecsTaskEvents = new lambdaNodejs.NodejsFunction(this, "EcsTaskEventsLambda", {
      ...lambdaDefaults,
      entry: path.join(rootDir, "src/lambdas/ecs-task-events/index.ts"),
      logGroup: ecsTaskEventsLogGroup,
      environment: {
        ...commonEnvironment,
        NOTIFICATION_WEBHOOK_SECRET_NAME: secretNames.notificationWebhookUrl,
        HOSTED_ZONE_ID: hostedZoneId ?? "",
      },
    });

    const stopServerLogGroup = new logs.LogGroup(this, "StopServerLogGroup", {
      logGroupName: prefixedLogGroupName(resourceNameSegment, "lambda/stop-server"),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const stopServer = new lambdaNodejs.NodejsFunction(this, "StopServerLambda", {
      ...lambdaDefaults,
      entry: path.join(rootDir, "src/lambdas/stop-server/index.ts"),
      logGroup: stopServerLogGroup,
      environment: {
        ...commonEnvironment,
        NOTIFICATION_WEBHOOK_SECRET_NAME: secretNames.notificationWebhookUrl,
      },
    });
    stopServer.grantInvoke(stopSchedulerRole);
    discordInteractions.addEnvironment("STOP_SERVER_FUNCTION_ARN", stopServer.functionArn);

    const api = new apigwv2.HttpApi(this, "AsaDiscordHttpApi");
    api.addRoutes({
      path: "/discord/interactions",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("DiscordInteractionsPostIntegration", discordInteractions),
    });

    new events.Rule(this, "AsaTaskStateChangeRule", {
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          clusterArn: [cluster.clusterArn],
        },
      },
      targets: [new targets.LambdaFunction(ecsTaskEvents)],
    });

    stateTable.grantReadWriteData(discordInteractions);
    stateTable.grantReadWriteData(ecsTaskEvents);
    stateTable.grantReadWriteData(stopServer);
    stateBucket.grantPut(discordInteractions, s3Pattern(resourcePrefix, "runtime/*"));
    stateBucket.grantRead(discordInteractions, s3Pattern(resourcePrefix, "runtime/*"));

    for (const fn of [discordInteractions, stopServer]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ecs:DescribeTasks", "ecs:StopTask"],
          resources: ["*"],
          conditions: {
            ArnEquals: { "ecs:cluster": cluster.clusterArn },
          },
        }),
      );
    }
    discordInteractions.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [taskDefinition.taskDefinitionArn],
        conditions: {
          ArnEquals: { "ecs:cluster": cluster.clusterArn },
        },
      }),
    );
    discordInteractions.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [taskDefinition.taskRole.roleArn, executionRole.roleArn],
      }),
    );
    discordInteractions.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:scheduler:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:schedule/default/${commonEnvironment.STOP_SCHEDULE_NAME}`,
        ],
      }),
    );
    discordInteractions.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [stopSchedulerRole.roleArn],
      }),
    );
    stopServer.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["scheduler:DeleteSchedule", "scheduler:GetSchedule"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:scheduler:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:schedule/default/${commonEnvironment.STOP_SCHEDULE_NAME}`,
        ],
      }),
    );
    ecsTaskEvents.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks", "ec2:DescribeNetworkInterfaces"],
        resources: ["*"],
      }),
    );

    for (const fn of [discordInteractions, ecsTaskEvents, stopServer]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: Object.values(parameterNames).map(
            (name) => `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${name}`,
          ),
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: Object.values(secretNames).map(
            (name) => `arn:${cdk.Aws.PARTITION}:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${name}*`,
          ),
        }),
      );
    }

    if (hostedZoneId && domainName) {
      if (!hostedZoneName) throw new Error("hostedZoneName context is required with hostedZoneId and domainName.");
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "AsaHostedZone", {
        hostedZoneId,
        zoneName: hostedZoneName,
      });
      ecsTaskEvents.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["route53:ChangeResourceRecordSets"],
          resources: [zone.hostedZoneArn],
        }),
      );
    }

    if (enableAwsBudget) {
      if (!budgetEmail) throw new Error("budgetEmail context is required when enableAwsBudget=true.");
      new budgets.CfnBudget(this, "AsaMonthlyBudget", {
        budget: {
          budgetName: resourcePrefix ? `asa-on-demand-${resourceNameSegment}-monthly-budget` : "asa-on-demand-monthly-budget",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {
            amount: monthlyBudgetJpy / jpyPerUsd,
            unit: "USD",
          },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }],
          },
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: budgetEmail }],
          },
        ],
      });
    }

    new cdk.CfnOutput(this, "DiscordInteractionsEndpointUrl", {
      value: `${api.apiEndpoint}/discord/interactions`,
    });
    new cdk.CfnOutput(this, "AsaStateBucketName", { value: stateBucket.bucketName });
    new cdk.CfnOutput(this, "AsaClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "AsaTaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "AsaSecurityGroupId", { value: serverSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, "AsaStateTableName", { value: stateTable.tableName });
    if (domainName) new cdk.CfnOutput(this, "OptionalDomainName", { value: domainName });
  }
}
