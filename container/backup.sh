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
archive_completion_marker="${BACKUP_ARCHIVE_COMPLETION_MARKER:-${BACKUP_COMPLETION_MARKER:-${tmp_root%/}/last-archive.completed}}"
promotion_max_attempts="${BACKUP_PROMOTION_MAX_ATTEMPTS:-3}"
promotion_retry_seconds="${BACKUP_PROMOTION_RETRY_INITIAL_SECONDS:-2}"
if [[ ! "${promotion_max_attempts}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_PROMOTION_MAX_ATTEMPTS must be a positive integer." >&2
  exit 2
fi
if [[ ! "${promotion_retry_seconds}" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_PROMOTION_RETRY_INITIAL_SECONDS must be a non-negative integer." >&2
  exit 2
fi
exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another full backup is already in progress; skipping duplicate request."
  exit 0
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_at="$(
  printf '%s-%s-%sT%s:%s:%sZ\n' \
    "${timestamp:0:4}" "${timestamp:4:2}" "${timestamp:6:2}" \
    "${timestamp:9:2}" "${timestamp:11:2}" "${timestamp:13:2}"
)"
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
    -type f \
    ! -name '*_AntiCorruptionBackup.bak' \
    ! -name '*_NewLaunchBackup.bak' \
    ! -name '*.arkrbf' \
    ! -name '*.profilebak' \
    ! -name '*.tribebak' \
    ! -name '*_[0-9][0-9].[0-9][0-9].[0-9][0-9][0-9][0-9]_[0-9][0-9].[0-9][0-9].[0-9][0-9].ark' \
    -printf '%T@\n' 2>/dev/null \
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
# Copy only restore-required data into the stable snapshot. Logs, diagnostics,
# and Cross-ARK data are stored elsewhere. ASA also keeps its own rollback
# copies beside the live world/player/tribe files; our dated S3 archives replace
# that rollback mechanism, so omit those copies before local I/O and compression.
snapshot_excludes=(
  "--exclude=clusters"
  "--exclude=Logs"
  "--exclude=Crashes"
  "--exclude=Profiling"
  "--exclude=Screenshots"
  "--exclude=Config/WindowsServer/GameUserSettings.ini"
  "--exclude=Config/WindowsServer/Game.ini"
  "--exclude=*_AntiCorruptionBackup.bak"
  "--exclude=*_NewLaunchBackup.bak"
  "--exclude=*.arkrbf"
  "--exclude=*.profilebak"
  "--exclude=*.tribebak"
  "--exclude=*_[0-9][0-9].[0-9][0-9].[0-9][0-9][0-9][0-9]_[0-9][0-9].[0-9][0-9].[0-9][0-9].ark"
)
nice -n "${BACKUP_NICE_LEVEL:-15}" ionice -c 3 \
  tar -cf - "${snapshot_excludes[@]}" -C "${saved_dir}" . \
  | nice -n "${BACKUP_NICE_LEVEL:-15}" ionice -c 3 tar -xf - -C "${snapshot_dir}/Saved"

nice -n "${BACKUP_NICE_LEVEL:-15}" ionice -c 3 tar --zstd -cf "${archive}" -C "${snapshot_dir}" Saved

# Upload the archive through the task ENI once. The stable restore key is then
# created by an S3-side copy, so the same archive does not cross the ENI twice.
aws s3 cp "${archive}" "s3://${S3_BUCKET}/${dated_key}" --no-progress
# The scheduler tracks completion of this expensive snapshot/upload stage.
# Promotion failures must not cause it to recompress and upload the same save
# every time the scheduler checks again.
touch "${archive_completion_marker}"

# Do not copy tags or metadata. The archive has no restore-relevant object
# properties, and `--copy-props none` avoids extra GetObjectTagging and
# PutObjectTagging calls. Retry only this S3-side promotion, never the upload.
last_backup_uri="s3://${S3_BUCKET}/${S3_RUNTIME_PREFIX}last-backup.json"
promoted_backup_key() {
  aws s3 cp "${last_backup_uri}" - --no-progress 2>/dev/null \
    | jq -r '.key // empty' 2>/dev/null \
    || true
}

promotion_attempt=1
while true; do
  # A retry from an older task must never overwrite a backup that a newer task
  # has already promoted. Keys are UTC timestamps in lexicographic order.
  already_promoted_key="$(promoted_backup_key)"
  if [[
    "${already_promoted_key}" == "${S3_BACKUP_PREFIX}"* &&
    ( "${already_promoted_key}" == "${dated_key}" || "${already_promoted_key}" > "${dated_key}" )
  ]]; then
    echo "Skipping stale promotion for ${dated_key}; ${already_promoted_key} is already current."
    exit 0
  fi

  if aws s3 cp \
    "s3://${S3_BUCKET}/${dated_key}" \
    "s3://${S3_BUCKET}/${S3_SAVE_KEY}" \
    --copy-props none \
    --no-progress; then
    break
  fi
  if (( promotion_attempt >= promotion_max_attempts )); then
    echo "Failed to promote ${dated_key} after ${promotion_attempt} attempts; the dated backup is safe in S3." >&2
    exit 1
  fi
  echo "Failed to promote ${dated_key}; retrying in ${promotion_retry_seconds}s." >&2
  sleep "${promotion_retry_seconds}"
  promotion_attempt=$(( promotion_attempt + 1 ))
  promotion_retry_seconds=$(( promotion_retry_seconds * 2 ))
done

promoted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n \
  --arg backupAt "${backup_at}" \
  --arg promotedAt "${promoted_at}" \
  --arg key "${dated_key}" \
  --arg runId "${ASA_RUN_ID}" \
  '{lastBackupAt: $promotedAt, backupAt: $backupAt, promotedAt: $promotedAt, key: $key, runId: $runId}' \
  | aws s3 cp - "${last_backup_uri}" --content-type application/json --no-progress
