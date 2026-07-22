#!/usr/bin/env bash
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_SAVE_KEY:?S3_SAVE_KEY is required}"
: "${S3_BACKUP_PREFIX:?S3_BACKUP_PREFIX is required}"
: "${S3_RUNTIME_PREFIX:?S3_RUNTIME_PREFIX is required}"
: "${ASA_INSTALL_DIR:?ASA_INSTALL_DIR is required}"
: "${ASA_RUN_ID:?ASA_RUN_ID is required}"

tmp_root="${ASA_TMP_ROOT:-/asa/tmp}"
scripts_root="${ASA_SCRIPTS_DIR:-/asa/scripts}"
mkdir -p "${tmp_root}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dated_path="$(date -u +%Y/%m/%d)/${timestamp}.tar.zst"
archive="${tmp_root%/}/current-${timestamp}.tar.zst"
snapshot_dir="${tmp_root%/}/backup-snapshot-${timestamp}"
saved_dir="${ASA_INSTALL_DIR}/ShooterGame/Saved"

if [[ ! -d "${saved_dir}" ]]; then
  echo "Saved directory does not exist: ${saved_dir}"
  exit 0
fi

cleanup() {
  rm -rf "${snapshot_dir}"
  rm -f "${archive}"
}
trap cleanup EXIT

if [[ "${SKIP_RCON_SAVE:-false}" != "true" ]]; then
  if ! "${scripts_root}/rcon.py" SaveWorld; then
    echo "RCON SaveWorld failed; archiving the latest save on disk." >&2
  fi
  sleep "${BACKUP_SAVE_DELAY_SECONDS:-8}"
fi

latest_mtime() {
  find "${saved_dir}" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1
}

# The server keeps writing save files independently of SaveWorld, so archiving
# the live directory races with those writes (tar: file changed as we read it).
# Wait until writes settle, then archive a snapshot copy instead.
quiesce_deadline=$(( SECONDS + ${BACKUP_QUIESCE_TIMEOUT_SECONDS:-60} ))
previous_mtime="$(latest_mtime)"
while (( SECONDS < quiesce_deadline )); do
  sleep "${BACKUP_QUIESCE_INTERVAL_SECONDS:-5}"
  current_mtime="$(latest_mtime)"
  if [[ "${current_mtime}" == "${previous_mtime}" ]]; then
    break
  fi
  previous_mtime="${current_mtime}"
done
if [[ "$(latest_mtime)" != "${previous_mtime}" ]]; then
  echo "Save writes did not settle within timeout; snapshotting anyway." >&2
fi

mkdir -p "${snapshot_dir}"
cp -a "${saved_dir}" "${snapshot_dir}/"
# Cross-ARK data lives only on EFS. Never re-introduce it into a map archive.
rm -rf "${snapshot_dir}/Saved/clusters"
# Runtime config contains injected passwords and is rebuilt from common/Map
# config plus Secrets Manager on every start.
rm -f \
  "${snapshot_dir}/Saved/Config/WindowsServer/GameUserSettings.ini" \
  "${snapshot_dir}/Saved/Config/WindowsServer/Game.ini"

tar --zstd -cf "${archive}" -C "${snapshot_dir}" Saved
aws s3 cp "${archive}" "s3://${S3_BUCKET}/${S3_SAVE_KEY}"
aws s3 cp "${archive}" "s3://${S3_BUCKET}/${S3_BACKUP_PREFIX}${dated_path}"
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg key "${S3_BACKUP_PREFIX}${dated_path}" --arg runId "${ASA_RUN_ID}" \
  '{lastBackupAt: $at, key: $key, runId: $runId}' \
  | aws s3 cp - "s3://${S3_BUCKET}/${S3_RUNTIME_PREFIX}last-backup.json" --content-type application/json
