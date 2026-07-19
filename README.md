# ASA On Demand

AWS CDK v2 project for running a private ARK: Survival Ascended dedicated server on ECS Fargate Spot, controlled through Discord Slash Commands.

The source spec is [asa-fargate-spot-discord-spec.md](./asa-fargate-spot-discord-spec.md). 日本語版は [README.ja.md](./README.ja.md)。

## Package Manager

Use pnpm, not npm. Workspace settings live in `pnpm-workspace.yaml`.

`minimumReleaseAge: 10080` is set, which is one week in minutes.

## Setup

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run synth
```

## First-Time Setup

The examples below use `--profile my-aws-profile` and the resource prefix `main`. For the default unprefixed environment, omit `--resource-prefix`, `--resourcePrefix`, `-c resourcePrefix`, and `RESOURCE_PREFIX`. Docker and AWS credentials are required.

1. Bootstrap the account and region (once per account/region):

   ```bash
   pnpm exec cdk bootstrap
   ```

2. Deploy the stack. The deploy creates the dedicated ECR repository, so the first deploy succeeds before any image exists:

   ```bash
   pnpm exec cdk deploy \
     -c region=ap-northeast-1 \
     -c resourcePrefix=main \
     -c monthlyBudgetJpy=1500 \
     -c monthlyRuntimeHoursLimit=80 \
     -c enableParallelMapTransfer=false \
     -c maxConcurrentMaps=2
   ```

3. Build and push the server image. SteamCMD downloads the ASA server during the build, and the resulting image is about 18.5 GB:

   ```bash
   ./scripts/push-image.sh \
     --region ap-northeast-1 \
     --profile my-aws-profile \
     --resource-prefix main
   ```

4. Store secrets and parameters (details in [Secrets And Parameters](#secrets-and-parameters)):

   ```bash
   RESOURCE_PREFIX=main ./local/put-secrets.sh --profile my-aws-profile
   ```

5. Optional: upload cluster-wide settings to `config/common/` in the state bucket (the `AsaStateBucketName` CDK output), and put only Map-specific overrides under `config/maps/<mapId>/`. The container applies common settings first and the Map overlay second on every start:

   ```bash
   aws s3 cp local/GameUserSettings.ini "s3://<AsaStateBucketName>/main/config/common/GameUserSettings.ini"
   aws s3 cp local/Game.ini "s3://<AsaStateBucketName>/main/config/common/Game.ini"
   aws s3 cp local/the-island/Game.ini "s3://<AsaStateBucketName>/main/config/maps/the-island/Game.ini"
   ```

6. In the Discord Developer Portal, set the Interactions Endpoint URL to the `DiscordInteractionsEndpointUrl` CDK output. Discord verifies the endpoint with a signed ping that the Lambda can only answer after step 4 stored the public key.

7. Register the guild commands (details in [Discord](#discord)):

   ```bash
   pnpm run discord:register \
     --profile my-aws-profile \
     --resourcePrefix main
   ```

8. Run `/asa start` in the guild.

Ordering constraints:

- Running `/asa start` before step 3 makes the ECS task stop with an image pull error.
- Steps 6 and 7 fail before step 4 because both read the Discord credentials from SSM and Secrets Manager.
- After a destroy/deploy cycle, the API Gateway URL changes: repeat step 6, and re-run step 4 if the secrets and parameters were deleted during teardown. The Discord commands themselves stay registered and need no re-registration.

## Resource Prefixes

Isolate each independent server environment in its own CloudFormation stack and S3 object namespace by setting `-c resourcePrefix`. Use a simple environment identifier such as `main`, without a Map name or a leading/trailing `/`; Map separation is handled below `maps/<mapId>/`. With `resourcePrefix=main`, state files are stored under:

- `main/config/common/`
- `main/config/maps/<mapId>/`
- `main/maps/<mapId>/saves/`
- `main/maps/<mapId>/backups/`
- `main/maps/<mapId>/runtime/`

The stack name becomes `AsaFargateStack-main`, auto-stop schedules are named `asa-main-<mapId>-auto-stop`, and log groups move under `/asa/main/...`.

## Parallel Map Transfers (PoC)

One stack is one ASA cluster. Each Map runs as an independent Fargate task with its own S3 save/runtime namespace, public IP, stop schedule, and DynamoDB row. Cross-ARK data alone is shared through encrypted EFS at `/asa/cluster`; every Map uses the same stable `asaClusterId` and `-ClusterDirOverride`.

The rollout flag defaults to `enableParallelMapTransfer=false`, which keeps concurrency at one while using the new schema. Migration, rollback, EFS restore, and the required in-game transfer acceptance steps are documented in [the parallel transfer runbook](./docs/parallel-map-transfer-runbook.md). Do not enable the flag in production merely because synth/unit tests pass: ASA + Proton + EFS semantics require an in-game two-Map PoC.

## Secrets And Parameters

Use [scripts/put-secrets.example.sh](./scripts/put-secrets.example.sh) as a template. Keep real secrets and local server configuration under the gitignored `local/` directory:

```bash
mkdir -p local
cp scripts/put-secrets.example.sh local/put-secrets.sh
```

For a prefixed environment, store SSM parameters and Secrets Manager secrets under the matching resource prefix:

```bash
RESOURCE_PREFIX=main ./local/put-secrets.sh --profile my-aws-profile
```

When `resourcePrefix` is set, SSM parameters and Secrets Manager secrets are read from `/asa/<resourcePrefix>`.

Required Secrets Manager values:

- `/asa/<resourcePrefix>/discord/bot-token`
- `/asa/<resourcePrefix>/discord/notification-webhook-url`
- `/asa/<resourcePrefix>/server/password`
- `/asa/<resourcePrefix>/server/admin-password`

Required SSM parameters:

- `/asa/<resourcePrefix>/discord/application-id`
- `/asa/<resourcePrefix>/discord/public-key`
- `/asa/<resourcePrefix>/discord/guild-id`
- `/asa/<resourcePrefix>/discord/allowed-role-ids`
- `/asa/<resourcePrefix>/discord/allowed-user-ids`
- `/asa/<resourcePrefix>/server/session-name`
- `/asa/<resourcePrefix>/server/default-map`
- `/asa/<resourcePrefix>/server/max-players`

Optional SSM parameters:

- `/asa/<resourcePrefix>/server/enabled-maps` — comma-separated map values such as `TheIsland_WP,ScorchedEarth_WP`. When absent, every map in the shared allowlist is enabled. SSM String parameters cannot be empty, so delete this parameter to remove the restriction. Re-run `pnpm run discord:register` after changing or deleting it.
- `/asa/<resourcePrefix>/server/event-mod-id` — the CurseForge project ID for the ASA event mod to launch. Every `/asa start` reads the latest value and applies it as `-mods=<ID>`. An absent/deleted parameter or `None` means no event mod. A change does not affect an already running task, so stop and restart the server.

For example, set the officially announced Summer Bash 2026 Mod ID `927091` in a prefixed environment:

```bash
aws ssm put-parameter \
  --profile my-aws-profile \
  --name /asa/main/server/event-mod-id \
  --type String \
  --value 927091 \
  --overwrite
```

Activation methods and Mod IDs can change between events. Check the latest Studio Wildcard announcement before setting the parameter.

For the default unprefixed environment, omit `resourcePrefix`; these become `/asa/discord/bot-token`, `/asa/server/default-map`, and so on. For `resourcePrefix=main`, they become `/asa/main/discord/bot-token`, `/asa/main/server/default-map`, and so on.

## Discord

Set the Discord Interactions Endpoint URL to the `DiscordInteractionsEndpointUrl` CDK output.

Register guild commands:

```bash
pnpm run discord:register \
  --profile my-aws-profile \
  --resourcePrefix main
```

The script reads the bot token from Secrets Manager, the application and guild IDs from SSM, and the optional map restriction from `server/enabled-maps`. The existing `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, and `ASA_ENABLED_MAPS` environment variables remain available as overrides.

## Useful Commands

```bash
pnpm run build
pnpm run test
pnpm run synth
pnpm run smoke
ASA_TEST_IMAGE=ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/REPOSITORY:BUILD_ID pnpm run test:container
pnpm run image:push --profile my-aws-profile
```

## Current Implementation Notes

- ECS tasks are started via `RunTask`; no ECS Service is created.
- The VPC has public subnets only and no NAT Gateway.
- Fargate Spot is the default capacity provider strategy. On-demand fallback is disabled unless `-c enableOnDemandFallback=true` is provided.
- The default task size is 4 vCPU and 24 GiB memory.
- Discord budget output shows both a conservative estimate (`hourlyCostJpy`, default 52 JPY/hour) and a variable Fargate Spot estimate (`spotHourlyCostJpy`, default 17 JPY/hour).
- `/asa start` reserves `session_hours` from 1 to 48 (default 8) against the monthly task-hour budget. It also accepts `idle_minutes` from 1 to 1440 (default 30) and stops after distinct fresh heartbeats report zero players for that interval. Missing or stale/wrong-run heartbeats do not trigger an idle stop.
- ASA and UMU-Proton are installed when `scripts/push-image.sh` builds the Docker image. CDK synth and deploy do not invoke Docker.
- To pick up an ASA update, first run `./scripts/push-image.sh --build-id 2026-07-05`, then deploy with the same tag using `pnpm exec cdk deploy -c asaBuildId=2026-07-05`. A missing or mismatched tag makes the ECS task stop with an image pull error.
- `-c asaUpdateOnStart=true` enables a SteamCMD update on every task start for emergency use. It is disabled by default.
- Map choices are validated by the Lambda and registered from a shared allowlist. The optional `server/enabled-maps` parameter restricts each environment to a subset; re-run `pnpm run discord:register` after changing the shared list or this parameter.
- Select an ASA event mod with the optional `server/event-mod-id` parameter. The Lambda reads it for every start and passes only a numeric project ID to the ECS task; the container appends `-mods=<ID>`. Start/status/info and READY notifications show the selected ID.
- Parallel transfer is a gated PoC: Map saves stay in independent S3 archives while Cross-ARK data is shared only through retained encrypted EFS. Cross-stack transfer is not supported.
- Discord commands immediately defer the interaction, run AWS operations asynchronously, and return the command result through a follow-up response. Readiness and lifecycle updates go to the configured Discord webhook.
- The state bucket is versioned; noncurrent object versions expire after 7 days through a bucket lifecycle rule.
- Each stack has a dedicated ECR repository that keeps the 2 most recent images and is deleted with its images when the stack is destroyed.
