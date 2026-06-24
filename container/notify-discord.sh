#!/usr/bin/env bash
set -euo pipefail

message="${1:-}"
if [[ -z "${message}" || -z "${DISCORD_WEBHOOK_URL:-}" ]]; then
  exit 0
fi

jq -n --arg content "${message}" '{content: $content}' \
  | curl -fsS -H 'content-type: application/json' -d @- "${DISCORD_WEBHOOK_URL}" >/dev/null

