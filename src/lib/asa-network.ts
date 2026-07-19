import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

export interface AsaNetworkResources {
  vpc: ec2.Vpc;
  serverSecurityGroup: ec2.SecurityGroup;
  efsSecurityGroup: ec2.SecurityGroup;
}

/** Creates the network boundary directly under the Stack scope to preserve logical IDs. */
export function createAsaNetwork(scope: Construct): AsaNetworkResources {
  const vpc = new ec2.Vpc(scope, "AsaVpc", {
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

  const serverSecurityGroup = new ec2.SecurityGroup(scope, "AsaServerSecurityGroup", {
    vpc,
    allowAllOutbound: true,
    disableInlineRules: true,
    description: "ASA Fargate task security group",
  });
  serverSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(7777), "ASA game port");
  serverSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(7778), "ASA adjacent UDP port");

  const efsSecurityGroup = new ec2.SecurityGroup(scope, "AsaClusterEfsSecurityGroup", {
    vpc,
    allowAllOutbound: false,
    disableInlineRules: true,
    description: "EFS ingress only from ASA map tasks",
  });
  efsSecurityGroup.addIngressRule(serverSecurityGroup, ec2.Port.tcp(2049), "NFS from ASA map tasks only");

  return { vpc, serverSecurityGroup, efsSecurityGroup };
}
