#!/usr/bin/env bash
set -euo pipefail

aws secretsmanager create-secret \
  --name /asa/discord/bot-token \
  --secret-string '<discord bot token>'

aws secretsmanager create-secret \
  --name /asa/discord/notification-webhook-url \
  --secret-string '<discord webhook url>'

aws secretsmanager create-secret \
  --name /asa/server/password \
  --secret-string '<join password>'

aws secretsmanager create-secret \
  --name /asa/server/admin-password \
  --secret-string '<admin password>'

aws ssm put-parameter --name /asa/discord/application-id --type String --value '<application id>'
aws ssm put-parameter --name /asa/discord/public-key --type String --value '<public key>'
aws ssm put-parameter --name /asa/discord/guild-id --type String --value '<guild id>'
aws ssm put-parameter --name /asa/discord/allowed-role-ids --type String --value '["123456789012345678"]'
aws ssm put-parameter --name /asa/discord/allowed-user-ids --type String --value '[]'
aws ssm put-parameter --name /asa/server/session-name --type String --value 'private-asa'
aws ssm put-parameter --name /asa/server/default-map --type String --value 'TheIsland_WP'
aws ssm put-parameter --name /asa/server/max-players --type String --value '4'

