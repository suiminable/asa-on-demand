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

Deploy a separate CloudFormation stack and S3 object namespace for each map by setting `resourcePrefix`:

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

## Secrets And Parameters

Use [scripts/put-secrets.example.sh](./scripts/put-secrets.example.sh) as a template. Do not commit real secrets.

For a prefixed map environment, store SSM parameters and Secrets Manager secrets under the matching resource prefix:

```bash
RESOURCE_PREFIX=maps/the-island ./scripts/put-secrets.example.sh
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
DISCORD_BOT_TOKEN=... \
DISCORD_APPLICATION_ID=... \
DISCORD_GUILD_ID=... \
pnpm run discord:register
```

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
- The container uses `umu-run` when available, then falls back to `proton`.
- ASA itself is downloaded at task startup by SteamCMD and is not baked into the image.
- The Discord start/stop commands return a direct interaction response after the AWS operation is accepted; readiness and lifecycle updates go to the configured Discord webhook.
