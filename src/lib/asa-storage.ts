import * as cdk from "aws-cdk-lib";
import * as backup from "aws-cdk-lib/aws-backup";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as efs from "aws-cdk-lib/aws-efs";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface AsaStorageProps {
  vpc: ec2.Vpc;
  efsSecurityGroup: ec2.SecurityGroup;
  resourcePrefix: string;
  clusterBackupRetentionDays: number;
}

export interface AsaStorageResources {
  clusterFileSystem: efs.FileSystem;
  clusterAccessPoint: efs.AccessPoint;
  clusterAdminAccessPoint: efs.AccessPoint;
  stateBucket: s3.Bucket;
}

/** Creates persistent storage directly under the Stack scope to preserve logical IDs. */
export function createAsaStorage(scope: Construct, props: AsaStorageProps): AsaStorageResources {
  const clusterFileSystem = new efs.FileSystem(scope, "AsaClusterFileSystem", {
    vpc: props.vpc,
    encrypted: true,
    lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    throughputMode: efs.ThroughputMode.BURSTING,
    securityGroup: props.efsSecurityGroup,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const clusterAccessPoint = clusterFileSystem.addAccessPoint("AsaClusterAccessPoint", {
    path: "/cluster-data",
    posixUser: { uid: "10001", gid: "10001" },
    createAcl: { ownerUid: "10001", ownerGid: "10001", permissions: "0750" },
  });
  const clusterAdminAccessPoint = clusterFileSystem.addAccessPoint("AsaClusterAdminAccessPoint", {
    path: "/",
    posixUser: { uid: "0", gid: "0" },
  });

  const clusterBackupVault = new backup.BackupVault(scope, "AsaClusterBackupVault");
  clusterBackupVault.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  const clusterBackupPlan = new backup.BackupPlan(scope, "AsaClusterBackupPlan", { backupVault: clusterBackupVault });
  clusterBackupPlan.addRule(
    new backup.BackupPlanRule({
      ruleName: "HourlySevenDays",
      scheduleExpression: events.Schedule.cron({ minute: "0" }),
      deleteAfter: cdk.Duration.days(7),
    }),
  );
  clusterBackupPlan.addRule(
    new backup.BackupPlanRule({
      ruleName: "DailyRetention",
      scheduleExpression: events.Schedule.cron({ minute: "15", hour: "18" }),
      deleteAfter: cdk.Duration.days(props.clusterBackupRetentionDays),
    }),
  );
  clusterBackupPlan.addSelection("AsaClusterEfsSelection", {
    resources: [backup.BackupResource.fromEfsFileSystem(clusterFileSystem)],
  });

  const stateBucket = new s3.Bucket(scope, "AsaStateBucket", {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    versioned: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [
      { prefix: `${props.resourcePrefix}logs/`, expiration: cdk.Duration.days(14) },
      { noncurrentVersionExpiration: cdk.Duration.days(7), expiredObjectDeleteMarker: true },
    ],
  });

  return { clusterFileSystem, clusterAccessPoint, clusterAdminAccessPoint, stateBucket };
}
