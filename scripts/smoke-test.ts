import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AsaFargateStack } from "../src/lib/asa-fargate-stack.js";
import { mapById, sessionNameFor } from "../src/shared/maps.js";
import { mapDnsName, mapStorageKeys, stopScheduleName, taskGroup } from "../src/shared/resources.js";

const app = new cdk.App({
  context: {
    region: "ap-northeast-1",
    asaEphemeralStorageGiB: 100,
    enableParallelMapTransfer: true,
    maxConcurrentMaps: 2,
  },
});
const stack = new AsaFargateStack(app, "SmokeAsaFargateStack");
const template = Template.fromStack(stack);

template.resourceCountIs("AWS::EC2::NatGateway", 0);
template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
template.resourcePropertiesCountIs("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7777, ToPort: 7777 }, 1);
template.resourcePropertiesCountIs("AWS::EC2::SecurityGroupIngress", { IpProtocol: "udp", FromPort: 7778, ToPort: 7778 }, 1);
template.resourcePropertiesCountIs("AWS::EC2::SecurityGroupIngress", { IpProtocol: "tcp", FromPort: 2049, ToPort: 2049 }, 1);
template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 3);
template.resourceCountIs("AWS::EFS::FileSystem", 1);
template.resourceCountIs("AWS::EFS::AccessPoint", 2);
template.resourceCountIs("AWS::Backup::BackupPlan", 1);
template.hasResourceProperties("AWS::Lambda::Function", {
  Environment: { Variables: Match.objectLike({ MAX_CONCURRENT_MAPS: "2" }) },
});

const island = mapById("the-island");
const scorched = mapById("scorched-earth");
assert(island);
assert(scorched);
const islandKeys = mapStorageKeys("smoke/", island.mapId);
const scorchedKeys = mapStorageKeys("smoke/", scorched.mapId);
for (const key of ["saveKey", "backupPrefix", "runtimePrefix", "heartbeatKey", "readyKey", "backupRequestKey", "lastBackupKey"] as const) {
  assert.notEqual(islandKeys[key], scorchedKeys[key], `${key} must be Map-scoped`);
}
assert.notEqual(taskGroup(island.mapId, "smoke-island-12345678"), taskGroup(scorched.mapId, "smoke-scorched-12345678"));
assert.notEqual(stopScheduleName("smoke", island.mapId), stopScheduleName("smoke", scorched.mapId));
assert.notEqual(sessionNameFor("private-asa", island), sessionNameFor("private-asa", scorched));
assert.equal(mapDnsName(island, "example.test"), "the-island.example.test");
assert.equal(mapDnsName(scorched, "example.test"), "scorched-earth.example.test");

console.log("Parallel two-Map smoke assertions passed.");
