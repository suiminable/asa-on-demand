#!/usr/bin/env node
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { parseStorageMigrationArguments, runStorageMigration, STORAGE_MIGRATION_USAGE } from "../src/operations/storage-migration.js";

async function main(): Promise<void> {
  const parsed = parseStorageMigrationArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(STORAGE_MIGRATION_USAGE);
    return;
  }

  const credentials = parsed.arguments.profile ? fromIni({ profile: parsed.arguments.profile }) : undefined;
  const clientConfig = {
    ...(parsed.arguments.region ? { region: parsed.arguments.region } : {}),
    ...(credentials ? { credentials } : {}),
  };
  await runStorageMigration(parsed.arguments, {
    clients: {
      cloudFormation: new CloudFormationClient(clientConfig),
      dynamodb: new DynamoDBClient(clientConfig),
      ecs: new ECSClient(clientConfig),
      s3: new S3Client(clientConfig),
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
