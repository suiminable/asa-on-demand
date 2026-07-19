import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AsaFargateStack } from "../src/lib/asa-fargate-stack.js";

function synthTemplate(context: Record<string, unknown> = {}) {
  const app = new cdk.App({
    context: {
      region: "ap-northeast-1",
      asaEphemeralStorageGiB: 100,
      asaStopTimeoutSeconds: 120,
      ...context,
    },
  });
  return Template.fromStack(new AsaFargateStack(app, "TestAsaFargateStack"));
}

function taskImage(template: Template): unknown {
  const taskDefinitions = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
  return taskDefinitions[0].Properties.ContainerDefinitions[0].Image;
}

function expectedEcrImage(repositoryLogicalId: string, tag: string): unknown {
  const repositoryArn = { "Fn::GetAtt": [repositoryLogicalId, "Arn"] };
  return {
    "Fn::Join": [
      "",
      [
        { "Fn::Select": [4, { "Fn::Split": [":", repositoryArn] }] },
        ".dkr.ecr.",
        { "Fn::Select": [3, { "Fn::Split": [":", repositoryArn] }] },
        ".",
        { Ref: "AWS::URLSuffix" },
        "/",
        { Ref: repositoryLogicalId },
        `:${tag}`,
      ],
    ],
  };
}

describe("AsaFargateStack", () => {
  it("does not create excluded compute/network resources", () => {
    const template = synthTemplate();
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::AutoScaling::AutoScalingGroup", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
  });

  it("opens game UDP publicly and NFS only from the server security group", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7777, ToPort: 7777 });
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7778, ToPort: 7778 });
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      IpProtocol: "tcp",
      FromPort: 2049,
      ToPort: 2049,
      SourceSecurityGroupId: Match.anyValue(),
    });
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 3);
  });

  it("mounts retained encrypted EFS through an IAM-authorized access point and backs it up", () => {
    const template = synthTemplate();
    template.hasResource("AWS::EFS::FileSystem", { DeletionPolicy: "Retain", Properties: { Encrypted: true } });
    template.resourceCountIs("AWS::EFS::AccessPoint", 2);
    template.hasResourceProperties("AWS::EFS::AccessPoint", {
      PosixUser: { Uid: "10001", Gid: "10001" },
      RootDirectory: { CreationInfo: { OwnerUid: "10001", OwnerGid: "10001", Permissions: "0750" }, Path: "/cluster-data" },
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Volumes: Match.arrayWith([
        Match.objectLike({
          Name: "AsaClusterData",
          EFSVolumeConfiguration: Match.objectLike({
            TransitEncryption: "ENABLED",
            AuthorizationConfig: Match.objectLike({ IAM: "ENABLED" }),
          }),
        }),
      ]),
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ MountPoints: [{ ContainerPath: "/asa/cluster", ReadOnly: false, SourceVolume: "AsaClusterData" }] }),
      ]),
    });
    template.resourceCountIs("AWS::Backup::BackupPlan", 1);
    template.hasResource("AWS::Backup::BackupVault", { DeletionPolicy: "Retain" });
    template.hasResourceProperties("AWS::Backup::BackupPlan", {
      BackupPlan: {
        BackupPlanRule: Match.arrayWith([
          Match.objectLike({ RuleName: "HourlySevenDays", Lifecycle: { DeleteAfterDays: 7 } }),
          Match.objectLike({ RuleName: "DailyRetention", Lifecycle: { DeleteAfterDays: 35 } }),
        ]),
      },
    });
    const selections = Object.values(template.findResources("AWS::Backup::BackupSelection"));
    expect(selections).toHaveLength(1);
    expect(selections[0].Properties.BackupSelection.Resources).toHaveLength(1);
    expect(JSON.stringify(selections[0].Properties.BackupSelection.Resources[0])).toContain(":elasticfilesystem:");
  });

  it("runs only the dedicated storage migration task as root on the EFS admin mount", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::EFS::AccessPoint", {
      PosixUser: { Uid: "0", Gid: "0" },
      RootDirectory: { Path: "/" },
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          User: "0",
          Environment: Match.arrayWith([
            { Name: "ASA_CLUSTER_DIR", Value: "/asa/efs-root/cluster-data" },
            { Name: "EFS_ADMIN_ROOT", Value: "/asa/efs-root" },
          ]),
          MountPoints: [{ ContainerPath: "/asa/efs-root", ReadOnly: false, SourceVolume: "AsaClusterAdminData" }],
        }),
      ]),
    });
    const taskDefinitions = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
    const rootContainers = taskDefinitions
      .flatMap((resource) => resource.Properties.ContainerDefinitions)
      .filter((container) => container.User === "0");
    expect(rootContainers).toHaveLength(1);
    const migrationTask = taskDefinitions.find((resource) =>
      resource.Properties.ContainerDefinitions.some((container: { User?: string }) => container.User === "0"),
    );
    expect(migrationTask?.Properties).toMatchObject({ Cpu: "2048", Memory: "4096", EphemeralStorage: { SizeInGiB: 100 } });
  });

  it("configures Fargate Linux task storage and stop timeout", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RequiresCompatibilities: ["FARGATE"],
      Cpu: "4096",
      Memory: "24576",
      EphemeralStorage: { SizeInGiB: 100 },
      RuntimePlatform: {
        CpuArchitecture: "X86_64",
        OperatingSystemFamily: "LINUX",
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          StopTimeout: 120,
          HealthCheck: {
            Command: ["CMD-SHELL", "/asa/scripts/healthcheck.sh"],
            Interval: 30,
            Retries: 3,
            StartPeriod: 300,
            Timeout: 5,
          },
          Environment: Match.arrayWith([
            { Name: "ASA_CLUSTER_ID", Value: "asa-on-demand" },
            { Name: "ASA_UPDATE_ON_START", Value: "false" },
          ]),
        }),
      ]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          DEFAULT_IDLE_MINUTES: "30",
          HEARTBEAT_FRESHNESS_SECONDS: "180",
          HOURLY_COST_JPY: "52",
          SPOT_HOURLY_COST_JPY: "17",
        }),
      },
    });
    template.hasOutput("AsaClusterId", { Value: "asa-on-demand" });
  });

  it("configures and validates the default idle timeout", () => {
    const template = synthTemplate({ defaultIdleMinutes: 45 });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ DEFAULT_IDLE_MINUTES: "45" }) },
    });
    expect(() => synthTemplate({ defaultIdleMinutes: 0 })).toThrow("defaultIdleMinutes must be an integer from 1 to 1440");
    expect(() => synthTemplate({ defaultIdleMinutes: 1.5 })).toThrow("defaultIdleMinutes must be an integer from 1 to 1440");
  });

  it("keeps the rollout at one Map until parallel transfer is explicitly enabled", () => {
    const disabled = synthTemplate({ maxConcurrentMaps: 2 });
    disabled.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ MAX_CONCURRENT_MAPS: "1" }) },
    });
    const enabled = synthTemplate({ enableParallelMapTransfer: true, maxConcurrentMaps: 2 });
    enabled.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ MAX_CONCURRENT_MAPS: "2" }) },
    });
    expect(() => synthTemplate({ maxConcurrentMaps: 0 })).toThrow("maxConcurrentMaps must be an integer from 1 to 10");
  });

  it("requires a complete Map DNS configuration", () => {
    expect(() => synthTemplate({ domainName: "asa.example.test" })).toThrow(
      "Contexts hostedZoneId and domainName must be configured together.",
    );
    expect(() => synthTemplate({ hostedZoneId: "zone-1" })).toThrow("Contexts hostedZoneId and domainName must be configured together.");
    expect(() => synthTemplate({ hostedZoneId: "zone-1", domainName: "asa.example.test" })).toThrow("hostedZoneName context is required");
    const configured = synthTemplate({ hostedZoneId: "zone-1", hostedZoneName: "example.test", domainName: "asa.example.test" });
    configured.hasOutput("AsaMapDnsPattern", { Value: "<mapId>.asa.example.test" });
    configured.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: "route53:ChangeResourceRecordSets", Effect: "Allow" })]),
      },
    });
  });

  it("enables operation reconciliation and TTL for the Map state schema", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "operations-by-phase",
          KeySchema: [
            { AttributeName: "phase", KeyType: "HASH" },
            { AttributeName: "updatedAt", KeyType: "RANGE" },
          ],
        }),
      ]),
    });
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)", State: "ENABLED" });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ STOP_SERVER_FUNCTION_ARN: Match.anyValue() }) },
    });
  });

  it("allows the Discord Lambda to invoke its exact function ARN", () => {
    const template = synthTemplate({ resourcePrefix: "maps/the-island" });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
            Resource: {
              "Fn::Join": Match.arrayWith([Match.arrayWith([":function:asa-maps-the-island-discord-df84a7b3"])]),
            },
          }),
        ]),
      },
    });
  });

  it("creates AWS Budgets in USD", () => {
    const template = synthTemplate({ enableAwsBudget: true, budgetEmail: "admin@example.com", monthlyBudgetJpy: 1500, jpyPerUsd: 150 });
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: "USD" } }),
    });
  });

  it("can explicitly update the bundled server at task startup", () => {
    const template = synthTemplate({ asaUpdateOnStart: true });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: "ASA_UPDATE_ON_START", Value: "true" }]),
        }),
      ]),
    });
  });

  it("creates no ECS service", () => {
    const template = synthTemplate();
    expect(() => template.resourceCountIs("AWS::ECS::Service", 0)).not.toThrow();
  });

  it("creates a dedicated ECR repository and uses its initial image", () => {
    const template = synthTemplate();
    const repositories = template.findResources("AWS::ECR::Repository");
    const [repositoryLogicalId] = Object.keys(repositories);

    template.resourceCountIs("AWS::ECR::Repository", 1);
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "asa-server",
      LifecyclePolicy: { LifecyclePolicyText: Match.anyValue() },
    });
    expect(taskImage(template)).toEqual(expectedEcrImage(repositoryLogicalId, "initial"));
  });

  it("scopes the ECR repository and image tag by context", () => {
    const template = synthTemplate({ resourcePrefix: "maps/the-island", asaBuildId: "2026-07-05" });
    const repositories = template.findResources("AWS::ECR::Repository");
    const [repositoryLogicalId] = Object.keys(repositories);

    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "asa-maps-the-island-server",
    });
    expect(taskImage(template)).toEqual(expectedEcrImage(repositoryLogicalId, "2026-07-05"));
  });

  it("rejects an invalid ECR image tag", () => {
    expect(() => synthTemplate({ asaBuildId: "invalid/tag" })).toThrow("Context asaBuildId must be a valid ECR image tag.");
  });

  it("uses the map-scoped S3 layout when no resource prefix is provided", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "S3_SAVE_KEY", Value: "maps/the-island/saves/current.tar.zst" },
            { Name: "S3_BACKUP_PREFIX", Value: "maps/the-island/backups/" },
            { Name: "S3_RUNTIME_PREFIX", Value: "maps/the-island/runtime/" },
            { Name: "S3_COMMON_CONFIG_PREFIX", Value: "config/common/" },
            { Name: "S3_MAP_CONFIG_PREFIX", Value: "config/maps/the-island/" },
            { Name: "BACKUP_REQUEST_KEY", Value: "maps/the-island/runtime/backup-request.json" },
            { Name: "HEARTBEAT_KEY", Value: "maps/the-island/runtime/heartbeat.json" },
          ]),
        }),
      ]),
    });
  });

  it("scopes the map layout and config namespace by resource prefix", () => {
    const template = synthTemplate({ resourcePrefix: "maps/the-island" });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "S3_SAVE_KEY", Value: "maps/the-island/maps/the-island/saves/current.tar.zst" },
            { Name: "S3_BACKUP_PREFIX", Value: "maps/the-island/maps/the-island/backups/" },
            { Name: "S3_RUNTIME_PREFIX", Value: "maps/the-island/maps/the-island/runtime/" },
            { Name: "S3_COMMON_CONFIG_PREFIX", Value: "maps/the-island/config/common/" },
            { Name: "S3_MAP_CONFIG_PREFIX", Value: "maps/the-island/config/maps/the-island/" },
            { Name: "BACKUP_REQUEST_KEY", Value: "maps/the-island/maps/the-island/runtime/backup-request.json" },
            { Name: "HEARTBEAT_KEY", Value: "maps/the-island/maps/the-island/runtime/heartbeat.json" },
          ]),
        }),
      ]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          CONFIG_PREFIX: "/asa/maps/the-island",
          RESOURCE_PREFIX: "maps/the-island/",
          ENVIRONMENT_NAME: "maps-the-island",
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:ListBucket",
            Condition: {
              StringLike: {
                "s3:prefix": ["maps/the-island/config/*", "maps/the-island/maps/*"],
              },
            },
          }),
        ]),
      },
    });
  });

  it("grants access to the scoped event mod parameter", () => {
    const template = synthTemplate({ resourcePrefix: "maps/the-island" });
    const policies = template.findResources("AWS::IAM::Policy");

    expect(JSON.stringify(policies)).toContain(":parameter/asa/maps/the-island/server/event-mod-id");
  });
});
