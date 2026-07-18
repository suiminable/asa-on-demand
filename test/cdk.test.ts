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

  it("opens only the expected UDP ports", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7777, ToPort: 7777 });
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7778, ToPort: 7778 });
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 2);
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
  });

  it("configures and validates the default idle timeout", () => {
    const template = synthTemplate({ defaultIdleMinutes: 45 });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ DEFAULT_IDLE_MINUTES: "45" }) },
    });
    expect(() => synthTemplate({ defaultIdleMinutes: 0 })).toThrow("defaultIdleMinutes must be an integer from 1 to 1440");
    expect(() => synthTemplate({ defaultIdleMinutes: 1.5 })).toThrow("defaultIdleMinutes must be an integer from 1 to 1440");
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

  it("keeps the default S3 layout when no resource prefix is provided", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "S3_SAVE_KEY", Value: "saves/current.tar.zst" },
            { Name: "S3_BACKUP_PREFIX", Value: "backups/" },
            { Name: "S3_CONFIG_PREFIX", Value: "config/" },
            { Name: "S3_RUNTIME_PREFIX", Value: "runtime/" },
            { Name: "BACKUP_REQUEST_KEY", Value: "runtime/backup-request.json" },
            { Name: "HEARTBEAT_KEY", Value: "runtime/heartbeat.json" },
          ]),
        }),
      ]),
    });
  });

  it("scopes S3 paths, scheduler name, and config namespace by resource prefix", () => {
    const template = synthTemplate({ resourcePrefix: "maps/the-island" });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "S3_SAVE_KEY", Value: "maps/the-island/saves/current.tar.zst" },
            { Name: "S3_BACKUP_PREFIX", Value: "maps/the-island/backups/" },
            { Name: "S3_CONFIG_PREFIX", Value: "maps/the-island/config/" },
            { Name: "S3_RUNTIME_PREFIX", Value: "maps/the-island/runtime/" },
            { Name: "BACKUP_REQUEST_KEY", Value: "maps/the-island/runtime/backup-request.json" },
            { Name: "HEARTBEAT_KEY", Value: "maps/the-island/runtime/heartbeat.json" },
          ]),
        }),
      ]),
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          CONFIG_PREFIX: "/asa/maps/the-island",
          S3_RUNTIME_PREFIX: "maps/the-island/runtime/",
          STOP_SCHEDULE_NAME: "asa-maps-the-island-auto-stop",
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
                "s3:prefix": [
                  "maps/the-island/config/*",
                  "maps/the-island/saves/*",
                  "maps/the-island/runtime/*",
                  "maps/the-island/backups/*",
                ],
              },
            },
          }),
        ]),
      },
    });
  });
});
