import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AsaFargateStack } from "../src/lib/asa-fargate-stack.js";

function synthTemplate() {
  const app = new cdk.App({
    context: {
      region: "ap-northeast-1",
      asaEphemeralStorageGiB: 100,
      asaStopTimeoutSeconds: 120,
    },
  });
  return Template.fromStack(new AsaFargateStack(app, "TestAsaFargateStack"));
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
    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 27015, ToPort: 27015 });
  });

  it("configures Fargate Linux task storage and stop timeout", () => {
    const template = synthTemplate();
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RequiresCompatibilities: ["FARGATE"],
      Cpu: "2048",
      Memory: "12288",
      EphemeralStorage: { SizeInGiB: 100 },
      RuntimePlatform: {
        CpuArchitecture: "X86_64",
        OperatingSystemFamily: "LINUX",
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          StopTimeout: 120,
        }),
      ]),
    });
  });

  it("creates no ECS service", () => {
    const template = synthTemplate();
    expect(() => template.resourceCountIs("AWS::ECS::Service", 0)).not.toThrow();
  });
});

