# ASA On Demand

AWS CDK v2 project for running a private ARK: Survival Ascended dedicated server on ECS Fargate Spot, controlled through Discord Slash Commands.

The source spec is [asa-fargate-spot-discord-spec.md](./asa-fargate-spot-discord-spec.md).

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

Bootstrap and deploy:

```bash
pnpm exec cdk bootstrap
pnpm exec cdk deploy \
  -c region=ap-northeast-1 \
  -c monthlyBudgetJpy=1500 \
  -c monthlyRuntimeHoursLimit=80
```

Isolate each independent server environment in its own CloudFormation stack and S3 object namespace by setting `resourcePrefix`:

```bash
pnpm exec cdk deploy \
  -c region=ap-northeast-1 \
  -c resourcePrefix=maps/the-island
```

With this prefix, state files are stored under:

- `maps/the-island/config/`
- `maps/the-island/saves/`
- `maps/the-island/backups/`
- `maps/the-island/runtime/`

The stack name becomes `AsaFargateStack-maps-the-island`, the auto-stop schedule name becomes `asa-maps-the-island-auto-stop`, and log groups move under `/asa/maps-the-island/...`.

## Asynchronous Map Transfers

Map transfer is supported only between maps started sequentially by the same stack. One stack runs one map at a time, and all its supported maps use the same ARK cluster ID, S3 save archive, and `ShooterGame/Saved/clusters` directory. Because the complete `Saved` directory is archived to S3, uploaded survivors, creatures, and items are restored when another map starts from that stack.

`resourcePrefix` identifies an independent server environment, not a map participating in a shared cluster. Different prefixes create separate stacks, buckets, and save archives; cross-stack transfer is intentionally unsupported even when `asaClusterId` values match. To transfer between The Island and another map, keep one `resourcePrefix` and select the destination with `/asa start map:<map>`.

Transfer workflow:

1. Upload the survivor, creatures, or items at an obelisk or transmitter.
2. Run `/asa backup` and wait for the backup notification, or stop the server cleanly.
3. Stop the current map.
4. Start the destination map with `/asa start map:<map>`.
5. Download the uploaded data on the destination map.

The cluster ID defaults to the normalized `resourcePrefix`, or `asa-on-demand` without a prefix. Override it with `-c asaClusterId=<stable-id>`. Changing it later makes existing transfer data unavailable under the new cluster ID. Matching IDs do not provide cross-stack transfer because stacks do not share save storage.

## Secrets And Parameters

Use [scripts/put-secrets.example.sh](./scripts/put-secrets.example.sh) as a template. Keep real secrets and local server configuration under the gitignored `local/` directory:

```bash
mkdir -p local
cp scripts/put-secrets.example.sh local/put-secrets.sh
```

For a prefixed map environment, store SSM parameters and Secrets Manager secrets under the matching resource prefix:

```bash
RESOURCE_PREFIX=maps/the-island ./local/put-secrets.sh --profile my-aws-profile
pnpm exec cdk deploy \
  -c resourcePrefix=maps/the-island
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

For the default unprefixed environment, omit `resourcePrefix`; these become `/asa/discord/bot-token`, `/asa/server/default-map`, and so on. For `resourcePrefix=maps/the-island`, they become `/asa/maps/the-island/discord/bot-token`, `/asa/maps/the-island/server/default-map`, and so on.

## Discord

Set the Discord Interactions Endpoint URL to the `DiscordInteractionsEndpointUrl` CDK output.

Register guild commands:

```bash
pnpm run discord:register \
  --profile my-aws-profile \
  --resourcePrefix maps/the-island
```

The script reads the bot token from Secrets Manager and the application and guild IDs from SSM. The existing `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID` environment variables remain available as overrides.
When deploying with a non-default `-c maxSessionHours=<hours>`, pass the same value as `--maxSessionHours <hours>` while registering commands.

## Useful Commands

```bash
pnpm run build
pnpm run test
pnpm run synth
pnpm run smoke
```

## Current Implementation Notes

- ECS tasks are started via `RunTask`; no ECS Service is created.
- The VPC has public subnets only and no NAT Gateway.
- Fargate Spot is the default capacity provider strategy. On-demand fallback is disabled unless `-c enableOnDemandFallback=true` is provided.
- The default task size is 4 vCPU and 24 GiB memory.
- Discord budget output shows both a conservative estimate (`hourlyCostJpy`, default 52 JPY/hour) and a variable Fargate Spot estimate (`spotHourlyCostJpy`, default 17 JPY/hour).
- ASA and UMU-Proton are installed in the Docker image during `cdk deploy`. Tasks use the bundled files and start Proton directly.
- To pick up an ASA update, deploy with a new build marker, for example `-c asaBuildId=2026-07-04`. This invalidates the Docker build cache and runs SteamCMD while rebuilding the image.
- `-c asaUpdateOnStart=true` enables a SteamCMD update on every task start for emergency use. It is disabled by default.
- Map choices are validated by the Lambda and registered from a shared allowlist. Re-run `pnpm run discord:register` after deploying changes to that list.
- Cross-map transfers within one stack are asynchronous: cluster data is included in that stack's S3 save archive, but multiple maps are not run simultaneously. Cross-stack transfer is not supported.
- Discord commands immediately defer the interaction, run AWS operations asynchronously, and return the command result through a follow-up response. Readiness and lifecycle updates go to the configured Discord webhook.
