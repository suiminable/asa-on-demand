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

## Secrets And Parameters

Use [scripts/put-secrets.example.sh](./scripts/put-secrets.example.sh) as a template. Do not commit real secrets.

Required Secrets Manager values:

- `/asa/discord/bot-token`
- `/asa/discord/notification-webhook-url`
- `/asa/server/password`
- `/asa/server/admin-password`

Required SSM parameters:

- `/asa/discord/application-id`
- `/asa/discord/public-key`
- `/asa/discord/guild-id`
- `/asa/discord/allowed-role-ids`
- `/asa/discord/allowed-user-ids`
- `/asa/server/session-name`
- `/asa/server/default-map`
- `/asa/server/max-players`

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

