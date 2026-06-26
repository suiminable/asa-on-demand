#!/usr/bin/env bash
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_SAVE_KEY:?S3_SAVE_KEY is required}"
: "${S3_BACKUP_PREFIX:?S3_BACKUP_PREFIX is required}"
: "${ASA_INSTALL_DIR:?ASA_INSTALL_DIR is required}"

S3_RUNTIME_PREFIX="${S3_RUNTIME_PREFIX:-runtime/}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dated_path="$(date -u +%Y/%m/%d)/${timestamp}.tar.zst"
archive="/asa/tmp/current-${timestamp}.tar.zst"
saved_dir="${ASA_INSTALL_DIR}/ShooterGame/Saved"

if [[ ! -d "${saved_dir}" ]]; then
  echo "Saved directory does not exist: ${saved_dir}"
  exit 0
fi

if command -v rcon-cli >/dev/null 2>&1; then
  rcon-cli --host 127.0.0.1 --port "${ASA_RCON_PORT}" --password "${ASA_ADMIN_PASSWORD}" SaveWorld || true
fi

sleep "${BACKUP_SAVE_DELAY_SECONDS:-8}"
tar --zstd -cf "${archive}" -C "${ASA_INSTALL_DIR}/ShooterGame" Saved
aws s3 cp "${archive}" "s3://${S3_BUCKET}/${S3_SAVE_KEY}"
aws s3 cp "${archive}" "s3://${S3_BUCKET}/${S3_BACKUP_PREFIX}${dated_path}"
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg key "${S3_BACKUP_PREFIX}${dated_path}" '{lastBackupAt: $at, key: $key}' \
  | aws s3 cp - "s3://${S3_BUCKET}/${S3_RUNTIME_PREFIX}last-backup.json" --content-type application/json
rm -f "${archive}"
