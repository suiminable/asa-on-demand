#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AsaFargateStack } from "../lib/asa-fargate-stack.js";

const app = new cdk.App();
const region = app.node.tryGetContext("region") ?? "ap-northeast-1";

new AsaFargateStack(app, "AsaFargateStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});

