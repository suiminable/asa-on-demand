#!/usr/bin/env bash
set -euo pipefail

AWS_ARGS=()
while (($# > 0)); do
  case "$1" in
    --profile)
      if (($# < 2)); then
        echo "--profile requires a profile name." >&2
        exit 2
      fi
      AWS_ARGS+=(--profile "$2")
      shift 2
      ;;
    *)
      echo "Usage: $0 [--profile PROFILE]" >&2
      exit 2
      ;;
  esac
done

aws_cli() {
  aws "${AWS_ARGS[@]}" "$@"
}

RESOURCE_PREFIX="${RESOURCE_PREFIX:-}"
RESOURCE_PREFIX="${RESOURCE_PREFIX#/}"
RESOURCE_PREFIX="${RESOURCE_PREFIX%/}"
CONFIG_PREFIX="/asa"
if [[ -n "${RESOURCE_PREFIX}" ]]; then
  CONFIG_PREFIX="/asa/${RESOURCE_PREFIX}"
fi

aws_cli secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/discord/bot-token" \
  --secret-string '<discord bot token>'

aws_cli secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/discord/notification-webhook-url" \
  --secret-string '<discord webhook url>'

aws_cli secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/server/password" \
  --secret-string '<join password>'

aws_cli secretsmanager create-secret \
  --name "${CONFIG_PREFIX}/server/admin-password" \
  --secret-string '<admin password>'

aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/discord/application-id" --type String --value '<application id>'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/discord/public-key" --type String --value '<public key>'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/discord/guild-id" --type String --value '<guild id>'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/discord/allowed-role-ids" --type String --value '["123456789012345678"]'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/discord/allowed-user-ids" --type String --value '[]'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/server/session-name" --type String --value 'private-asa'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/server/default-map" --type String --value 'TheIsland_WP'
# Optional: restrict selectable maps (comma-separated). Delete the parameter to allow all maps.
# aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/server/enabled-maps" --type String --value 'TheIsland_WP,ScorchedEarth_WP'
# Optional: activate an ASA event mod by CurseForge project ID. Use None or delete the parameter to disable it.
# Summer Bash 2026: 927091
# aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/server/event-mod-id" --type String --value '927091'
aws_cli ssm put-parameter --name "${CONFIG_PREFIX}/server/max-players" --type String --value '4'
