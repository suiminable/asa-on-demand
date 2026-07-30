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

printf 'world\n' >"${saved_root}/SavedArks/world.ark"
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
if tar --zstd -tf "${current_archive}" | grep -Eq '^Saved/(clusters|Logs|Crashes|Profiling|Screenshots)(/|$)'; then
  fail "archive contains excluded runtime data"
fi
if tar --zstd -tf "${current_archive}" | grep -Eq '^Saved/Config/WindowsServer/(GameUserSettings.ini|Game.ini)$'; then
  fail "archive contains runtime-injected configuration"
fi
[[ "$(grep -Ec '^s3 cp .*/current-[0-9TZ]+\.tar\.zst s3://' "${aws_log}")" == "1" ]] \
  || fail "local archive was uploaded more than once"
grep -Eq '^s3 cp s3://.*/backups/.+\.tar\.zst s3://.*/saves/current\.tar\.zst --no-progress[[:space:]]*$' "${aws_log}" \
  || fail "stable key was not created by an S3-side copy"
[[ -f "${tmp_root}/last-backup.completed" ]] || fail "completion marker is missing"
jq -e \
  '.runId == "run-astraeos-12345678" and (.key | startswith("fixture/maps/astraeos/backups/"))' \
  "${fake_s3}/${bucket}/${prefix}runtime/last-backup.json" >/dev/null

echo "Backup script assertions passed."
