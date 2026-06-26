#!/usr/bin/env bash
set -euo pipefail

RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"
RESOURCE_PREFIX="${RESOURCE_PREFIX#/}"
RESOURCE_PREFIX="${RESOURCE_PREFIX%/}"
CONFIG_PREFIX="/asa"
if [[ -n "${RESOURCE_PREFIX}" ]]; then
  CONFIG_PREFIX="/asa/${RESOURCE_PREFIX}"
fi

aws secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/discord/bot-token" \
  --secret-string '<discord bot token>'

aws secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/discord/notification-webhook-url" \
  --secret-string '<discord webhook url>'

aws secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/server/password" \
  --secret-string '<join password>'

aws secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/server/admin-password" \
  --secret-string '<admin password>'

aws ssm put-parameter --name "${CONFIG_PREFIX}/discord/application-id" --type String --value '<application id>'
aws ssm put-parameter --name "${CONFIG_PREFIX}/discord/public-key" --type String --value '<public key>'
aws ssm put-parameter --name "${CONFIG_PREFIX}/discord/guild-id" --type String --value '<guild id>'
aws ssm put-parameter --name "${CONFIG_PREFIX}/discord/allowed-role-ids" --type String --value '["123456789012345678"]'
aws ssm put-parameter --name "${CONFIG_PREFIX}/discord/allowed-user-ids" --type String --value '[]'
aws ssm put-parameter --name "${CONFIG_PREFIX}/server/session-name" --type String --value 'private-asa'
aws ssm put-parameter --name "${CONFIG_PREFIX}/server/default-map" --type String --value 'TheIsland_WP'
aws ssm put-parameter --name "${CONFIG_PREFIX}/server/max-players" --type String --value '4'
