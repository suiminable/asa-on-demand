#!/usr/bin/env bash
set -euo pipefail

image="${ASA_TEST_IMAGE:-}"
if [[ "${1:-}" == "--image" ]]; then
  image="${2:?--image requires a value}"
  shift 2
fi
if (( $# > 0 )) || [[ -z "${image}" ]]; then
  echo "Usage: ASA_TEST_IMAGE=IMAGE scripts/test-container-scripts.sh" >&2
  echo "   or: scripts/test-container-scripts.sh --image IMAGE" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
timeout "${ASA_CONTAINER_TEST_TIMEOUT_SECONDS:-900}" docker run --rm \
  --user 0 \
  --entrypoint bash \
  --mount "type=bind,src=${repo_root},dst=/workspace,readonly" \
  "${image}" \
  /workspace/test/container-scripts.test.sh

failure_log="$(mktemp /tmp/asa-entrypoint-no-efs.XXXXXX)"
cleanup() {
  rm -f -- "${failure_log}"
}
trap cleanup EXIT
if timeout 60 docker run --rm \
  --entrypoint /asa/scripts/entrypoint.sh \
  --mount "type=bind,src=${repo_root}/container,dst=/asa/scripts,readonly" \
  --env AWS_REGION=ap-northeast-1 \
  --env S3_BUCKET=fixture-bucket \
  --env S3_SAVE_KEY=maps/the-island/saves/current.tar.zst \
  --env S3_BACKUP_PREFIX=maps/the-island/backups/ \
  --env S3_RUNTIME_PREFIX=maps/the-island/runtime/ \
  --env S3_COMMON_CONFIG_PREFIX=config/common/ \
  --env S3_MAP_CONFIG_PREFIX=config/maps/the-island/ \
  --env BACKUP_REQUEST_KEY=maps/the-island/runtime/backup-request.json \
  --env HEARTBEAT_KEY=maps/the-island/runtime/heartbeat.json \
  --env READY_KEY=maps/the-island/runtime/ready.json \
  --env ASA_APP_ID=2430930 \
  --env ASA_INSTALL_DIR=/asa/server \
  --env ASA_MAP_ID=the-island \
  --env ASA_MAP=TheIsland_WP \
  --env ASA_RUN_ID=run-island-12345678 \
  --env ASA_SESSION_NAME=fixture-island \
  --env ASA_MAX_PLAYERS=4 \
  --env ASA_SERVER_PASSWORD=fixture \
  --env ASA_ADMIN_PASSWORD=fixture \
  --env ASA_PORT=7777 \
  --env ASA_RCON_PORT=27020 \
  --env ASA_CLUSTER_ID=cluster-fixture \
  "${image}" >"${failure_log}" 2>&1; then
  echo "entrypoint unexpectedly started without an EFS mount" >&2
  exit 1
fi
grep -Fq 'Shared cluster storage is not a writable mount point' "${failure_log}" || {
  cat "${failure_log}" >&2
  echo "entrypoint failed for a reason other than the missing EFS mount" >&2
  exit 1
}
echo "Entrypoint missing-EFS assertion passed."
