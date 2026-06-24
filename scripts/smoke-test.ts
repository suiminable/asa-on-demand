import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AsaFargateStack } from "../src/lib/asa-fargate-stack.js";

const app = new cdk.App({
  context: {
    region: "ap-northeast-1",
    asaEphemeralStorageGiB: 100,
  },
});
const stack = new AsaFargateStack(app, "SmokeAsaFargateStack");
const template = Template.fromStack(stack);

template.resourceCountIs("AWS::EC2::NatGateway", 0);
template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
template.resourcePropertiesCountIs("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7777, ToPort: 7777 }, 1);
template.resourcePropertiesCountIs("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7778, ToPort: 7778 }, 1);
template.resourcePropertiesCountIs("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 27015, ToPort: 27015 }, 1);

console.log("Smoke synth assertions passed.");

