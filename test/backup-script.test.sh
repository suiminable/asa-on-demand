#!/usr/bin/env bash
set -euo pipefail

repo_root="${REPO_ROOT:-/workspace}"
work_root="$(mktemp -d /tmp/asa-backup-test.XXXXXX)"
log_writer_pid=""
cleanup() {
  if [[ -n "${log_writer_pid}" ]]; then
    kill "${log_writer_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${work_root}"
}
trap cleanup EXIT

fail() {
  echo "backup script test failed: $*" >&2
  exit 1
}

fake_bin="${work_root}/bin"
fake_s3="${work_root}/s3"
bucket="fixture-bucket"
map_id="astraeos"
prefix="fixture/maps/${map_id}/"
install_root="${work_root}/install"
saved_root="${install_root}/ShooterGame/Saved"
tmp_root="${work_root}/tmp"
aws_log="${work_root}/aws.log"
real_tar="$(command -v tar)"
mkdir -p \
  "${fake_bin}" \
  "${fake_s3}/${bucket}" \
  "${saved_root}/SavedArks" \
  "${saved_root}/clusters" \
  "${saved_root}/Config/WindowsServer" \
  "${saved_root}/Logs" \
  "${saved_root}/Crashes" \
  "${saved_root}/Profiling" \
  "${saved_root}/Screenshots"
ln -s "${repo_root}/test/fixtures/fake-aws.sh" "${fake_bin}/aws"
ln -s "${repo_root}/test/fixtures/fake-flaky-tar.sh" "${fake_bin}/tar"
if ! command -v zstd >/dev/null 2>&1; then
  ln -s "${repo_root}/test/fixtures/fake-zstd.sh" "${fake_bin}/zstd"
fi
if ! command -v jq >/dev/null 2>&1; then
  ln -s "${repo_root}/test/fixtures/fake-jq.mjs" "${fake_bin}/jq"
fi

printf 'world\n' >"${saved_root}/SavedArks/world.ark"
printf 'player\n' >"${saved_root}/SavedArks/player.arkprofile"
printf 'tribe\n' >"${saved_root}/SavedArks/1234.arktribe"
printf 'dated-world-backup\n' >"${saved_root}/SavedArks/world_30.07.2026_10.46.28.ark"
printf 'rollback-backup\n' >"${saved_root}/SavedArks/world_30.07.2026_10.46.18.arkrbf"
printf 'anti-corruption-backup\n' >"${saved_root}/SavedArks/world_AntiCorruptionBackup.bak"
printf 'new-launch-backup\n' >"${saved_root}/SavedArks/world_NewLaunchBackup.bak"
printf 'player-backup\n' >"${saved_root}/SavedArks/player.profilebak"
printf 'tribe-backup\n' >"${saved_root}/SavedArks/1234.tribebak"
printf 'cluster\n' >"${saved_root}/clusters/transfer.dat"
printf 'secret\n' >"${saved_root}/Config/WindowsServer/GameUserSettings.ini"
printf 'runtime\n' >"${saved_root}/Config/WindowsServer/Game.ini"
printf 'log\n' >"${saved_root}/Logs/server.log"
printf 'crash\n' >"${saved_root}/Crashes/server.dmp"
printf 'profile\n' >"${saved_root}/Profiling/server.profile"
printf 'screenshot\n' >"${saved_root}/Screenshots/server.png"

export PATH="${fake_bin}:${PATH}"
export FAKE_S3_ROOT="${fake_s3}"
export FAKE_AWS_LOG="${aws_log}"
export REAL_TAR_BIN="${real_tar}"
(
  while true; do
    touch "${saved_root}/Logs/server.log"
    sleep 0.1
  done
) &
log_writer_pid="$!"
started_at="${SECONDS}"
env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${prefix}saves/current.tar.zst" \
  S3_BACKUP_PREFIX="${prefix}backups/" \
  S3_RUNTIME_PREFIX="${prefix}runtime/" \
  ASA_INSTALL_DIR="${install_root}" \
  ASA_RUN_ID=run-astraeos-12345678 \
  ASA_TMP_ROOT="${tmp_root}" \
  SKIP_RCON_SAVE=true \
  BACKUP_QUIESCE_INTERVAL_SECONDS=1 \
  BACKUP_QUIESCE_TIMEOUT_SECONDS=4 \
  bash "${repo_root}/container/backup.sh"
elapsed=$(( SECONDS - started_at ))
kill "${log_writer_pid}" 2>/dev/null || true
wait "${log_writer_pid}" 2>/dev/null || true
log_writer_pid=""
(( elapsed < 4 )) || fail "transient log writes kept the backup in its quiesce wait"

current_archive="${fake_s3}/${bucket}/${prefix}saves/current.tar.zst"
dated_archive="$(find "${fake_s3}/${bucket}/${prefix}backups" -type f -name '*.tar.zst' -print -quit)"
[[ -f "${current_archive}" ]] || fail "stable current archive is missing"
[[ -n "${dated_archive}" ]] || fail "dated archive is missing"
cmp "${dated_archive}" "${current_archive}" || fail "S3-side copy differs from the dated archive"
tar --zstd -tf "${current_archive}" | grep -Fqx 'Saved/SavedArks/world.ark' || fail "world save is missing"
tar --zstd -tf "${current_archive}" | grep -Fqx 'Saved/SavedArks/player.arkprofile' || fail "player save is missing"
tar --zstd -tf "${current_archive}" | grep -Fqx 'Saved/SavedArks/1234.arktribe' || fail "tribe save is missing"
if tar --zstd -tf "${current_archive}" | grep -Eq '^Saved/(clusters|Logs|Crashes|Profiling|Screenshots)(/|$)'; then
  fail "archive contains excluded runtime data"
fi
if tar --zstd -tf "${current_archive}" \
  | grep -Eq '(_AntiCorruptionBackup\.bak|_NewLaunchBackup\.bak|\.arkrbf|\.profilebak|\.tribebak|_[0-9]{2}\.[0-9]{2}\.[0-9]{4}_[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.ark)$'; then
  fail "archive contains ASA internal rollback data"
fi
if tar --zstd -tf "${current_archive}" | grep -Eq '^Saved/Config/WindowsServer/(GameUserSettings.ini|Game.ini)$'; then
  fail "archive contains runtime-injected configuration"
fi
[[ "$(grep -Ec '^s3 cp .*/current-[0-9TZ]+\.tar\.zst s3://' "${aws_log}")" == "1" ]] \
  || fail "local archive was uploaded more than once"
grep -Eq '^s3 cp s3://.*/backups/.+\.tar\.zst s3://.*/saves/current\.tar\.zst --copy-props none --no-progress[[:space:]]*$' "${aws_log}" \
  || fail "stable key was not created by an S3-side copy"
[[ -f "${tmp_root}/last-archive.completed" ]] || fail "archive completion marker is missing"
jq -e \
  '.runId == "run-astraeos-12345678"
    and (.key | startswith("fixture/maps/astraeos/backups/"))
    and (.backupAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and .promotedAt == .lastBackupAt' \
  "${fake_s3}/${bucket}/${prefix}runtime/last-backup.json" >/dev/null

snapshot_retry_prefix="fixture/maps/snapshot-retry/"
snapshot_retry_tmp_root="${work_root}/snapshot-retry-tmp"
snapshot_retry_aws_log="${work_root}/snapshot-retry-aws.log"
snapshot_retry_state="${work_root}/snapshot-retry-count"
env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${snapshot_retry_prefix}saves/current.tar.zst" \
  S3_BACKUP_PREFIX="${snapshot_retry_prefix}backups/" \
  S3_RUNTIME_PREFIX="${snapshot_retry_prefix}runtime/" \
  ASA_INSTALL_DIR="${install_root}" \
  ASA_RUN_ID=run-snapshot-retry-12345678 \
  ASA_TMP_ROOT="${snapshot_retry_tmp_root}" \
  SKIP_RCON_SAVE=true \
  BACKUP_QUIESCE_INTERVAL_SECONDS=0 \
  BACKUP_QUIESCE_TIMEOUT_SECONDS=1 \
  BACKUP_SNAPSHOT_MAX_ATTEMPTS=3 \
  BACKUP_SNAPSHOT_RETRY_SECONDS=0 \
  FAKE_AWS_LOG="${snapshot_retry_aws_log}" \
  FAKE_TAR_SNAPSHOT_FAILURES=1 \
  FAKE_TAR_FAILURE_STATE="${snapshot_retry_state}" \
  bash "${repo_root}/container/backup.sh"
[[ "$(<"${snapshot_retry_state}")" == "1" ]] || fail "snapshot race was not simulated exactly once"
[[ -f "${fake_s3}/${bucket}/${snapshot_retry_prefix}saves/current.tar.zst" ]] \
  || fail "backup did not recover from a transient snapshot race"
[[ "$(grep -Ec '^s3 cp .*/current-[0-9TZ]+\.tar\.zst s3://' "${snapshot_retry_aws_log}")" == "1" ]] \
  || fail "snapshot retry uploaded the local archive more than once"

failure_prefix="fixture/maps/promotion-failure/"
failure_tmp_root="${work_root}/failure-tmp"
failure_aws_log="${work_root}/failure-aws.log"
failure_state="${work_root}/failure-count"
if env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${failure_prefix}saves/current.tar.zst" \
  S3_BACKUP_PREFIX="${failure_prefix}backups/" \
  S3_RUNTIME_PREFIX="${failure_prefix}runtime/" \
  ASA_INSTALL_DIR="${install_root}" \
  ASA_RUN_ID=run-promotion-failure-12345678 \
  ASA_TMP_ROOT="${failure_tmp_root}" \
  SKIP_RCON_SAVE=true \
  BACKUP_QUIESCE_INTERVAL_SECONDS=0 \
  BACKUP_QUIESCE_TIMEOUT_SECONDS=1 \
  BACKUP_PROMOTION_MAX_ATTEMPTS=3 \
  BACKUP_PROMOTION_RETRY_INITIAL_SECONDS=0 \
  FAKE_AWS_LOG="${failure_aws_log}" \
  FAKE_AWS_FAIL_CURRENT_COPY_ATTEMPTS=3 \
  FAKE_AWS_FAILURE_STATE="${failure_state}" \
  bash "${repo_root}/container/backup.sh"; then
  fail "backup unexpectedly succeeded when every current promotion failed"
fi
[[ -f "${failure_tmp_root}/last-archive.completed" ]] \
  || fail "archive completion marker was not updated after the dated upload"
[[ -n "$(find "${fake_s3}/${bucket}/${failure_prefix}backups" -type f -name '*.tar.zst' -print -quit)" ]] \
  || fail "dated archive was lost when current promotion failed"
[[ ! -e "${fake_s3}/${bucket}/${failure_prefix}saves/current.tar.zst" ]] \
  || fail "current archive exists despite all promotion attempts failing"
[[ ! -e "${fake_s3}/${bucket}/${failure_prefix}runtime/last-backup.json" ]] \
  || fail "last-backup metadata was published before current promotion succeeded"
[[ "$(grep -Ec '^s3 cp .*/current-[0-9TZ]+\.tar\.zst s3://' "${failure_aws_log}")" == "1" ]] \
  || fail "promotion retries uploaded the local archive more than once"
[[ "$(grep -Ec '^s3 cp s3://.*/backups/.+\.tar\.zst s3://.*/saves/current\.tar\.zst --copy-props none --no-progress' "${failure_aws_log}")" == "3" ]] \
  || fail "current promotion did not use the configured retry count"

stale_prefix="fixture/maps/stale-promotion/"
stale_tmp_root="${work_root}/stale-tmp"
stale_aws_log="${work_root}/stale-aws.log"
stale_current="${fake_s3}/${bucket}/${stale_prefix}saves/current.tar.zst"
stale_metadata="${fake_s3}/${bucket}/${stale_prefix}runtime/last-backup.json"
mkdir -p "$(dirname "${stale_current}")" "$(dirname "${stale_metadata}")"
printf 'newer-current\n' >"${stale_current}"
printf \
  '{"lastBackupAt":"9999-12-31T23:59:59Z","backupAt":"9999-12-31T23:59:59Z","promotedAt":"9999-12-31T23:59:59Z","key":"%s","runId":"newer-run"}\n' \
  "${stale_prefix}backups/9999/12/31/99991231T235959Z.tar.zst" \
  >"${stale_metadata}"
env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${stale_prefix}saves/current.tar.zst" \
  S3_BACKUP_PREFIX="${stale_prefix}backups/" \
  S3_RUNTIME_PREFIX="${stale_prefix}runtime/" \
  ASA_INSTALL_DIR="${install_root}" \
  ASA_RUN_ID=run-stale-promotion-12345678 \
  ASA_TMP_ROOT="${stale_tmp_root}" \
  SKIP_RCON_SAVE=true \
  BACKUP_QUIESCE_INTERVAL_SECONDS=0 \
  BACKUP_QUIESCE_TIMEOUT_SECONDS=1 \
  FAKE_AWS_LOG="${stale_aws_log}" \
  bash "${repo_root}/container/backup.sh"
grep -Fqx 'newer-current' "${stale_current}" \
  || fail "a stale promotion overwrote the newer current archive"
jq -e '.runId == "newer-run"' "${stale_metadata}" >/dev/null \
  || fail "a stale promotion overwrote newer last-backup metadata"
if grep -Eq '^s3 cp s3://.*/backups/.+\.tar\.zst s3://.*/saves/current\.tar\.zst --copy-props none' "${stale_aws_log}"; then
  fail "a stale backup attempted to promote over a newer backup"
fi

echo "Backup script assertions passed."
