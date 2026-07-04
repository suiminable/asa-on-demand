#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AsaFargateStack } from "../lib/asa-fargate-stack.js";

const app = new cdk.App();
const region = app.node.tryGetContext("region") ?? "ap-northeast-1";
const rawResourcePrefix = String(app.node.tryGetContext("resourcePrefix") ?? "")
  .trim()
  .replace(/^\/+|\/+$/g, "");
const stackNameSegment =
  rawResourcePrefix
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "";
const stackName = stackNameSegment ? `AsaFargateStack-${stackNameSegment}` : "AsaFargateStack";

new AsaFargateStack(app, stackName, {
  stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});
