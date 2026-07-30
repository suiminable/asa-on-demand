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
lock_file="${BACKUP_LOCK_FILE:-${tmp_root%/}/backup.lock}"
completion_marker="${BACKUP_COMPLETION_MARKER:-${tmp_root%/}/last-backup.completed}"
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another full backup is already in progress; skipping duplicate request."
  exit 0
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dated_path="$(date -u +%Y/%m/%d)/${timestamp}.tar.zst"
dated_key="${S3_BACKUP_PREFIX}${dated_path}"
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
  find "${saved_dir}" \
    \( \
      -path "${saved_dir}/clusters" -o \
      -path "${saved_dir}/Logs" -o \
      -path "${saved_dir}/Crashes" -o \
      -path "${saved_dir}/Profiling" -o \
      -path "${saved_dir}/Screenshots" \
    \) -prune -o \
    -type f -printf '%T@\n' 2>/dev/null \
    | sort -n \
    | tail -1
}

# The server keeps writing save files independently of SaveWorld. Ignore the
# transient paths that are not archived, wait for relevant writes to settle,
# then archive a snapshot copy instead of racing the live directory.
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

mkdir -p "${snapshot_dir}/Saved"
# Logs, crash dumps, profiles, and screenshots are diagnostic/transient data.
# Cross-ARK data lives only on EFS. Exclude all of these before the snapshot
# copy to reduce local I/O as well as compression and S3 transfer work.
find "${saved_dir}" -mindepth 1 -maxdepth 1 \
  ! -name clusters \
  ! -name Logs \
  ! -name Crashes \
  ! -name Profiling \
  ! -name Screenshots \
  -exec cp -a -- {} "${snapshot_dir}/Saved/" \;
# Runtime config contains injected passwords and is rebuilt from common/Map
# config plus Secrets Manager on every start.
rm -f \
  "${snapshot_dir}/Saved/Config/WindowsServer/GameUserSettings.ini" \
  "${snapshot_dir}/Saved/Config/WindowsServer/Game.ini"

nice -n "${BACKUP_NICE_LEVEL:-15}" ionice -c 3 tar --zstd -cf "${archive}" -C "${snapshot_dir}" Saved

# Upload the archive through the task ENI once. The stable restore key is then
# created by an S3-side copy, so the same archive does not cross the ENI twice.
aws s3 cp "${archive}" "s3://${S3_BUCKET}/${dated_key}" --no-progress
aws s3 cp "s3://${S3_BUCKET}/${dated_key}" "s3://${S3_BUCKET}/${S3_SAVE_KEY}" --no-progress
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg key "${dated_key}" --arg runId "${ASA_RUN_ID}" \
  '{lastBackupAt: $at, key: $key, runId: $runId}' \
  | aws s3 cp - "s3://${S3_BUCKET}/${S3_RUNTIME_PREFIX}last-backup.json" --content-type application/json --no-progress
touch "${completion_marker}"
