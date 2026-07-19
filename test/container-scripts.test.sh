#!/usr/bin/env bash
set -euo pipefail

repo_root="${REPO_ROOT:-/workspace}"
work_root="$(mktemp -d /tmp/asa-container-test.XXXXXX)"
chmod 0755 "${work_root}"
cleanup() {
  rm -rf -- "${work_root}"
}
trap cleanup EXIT

fail() {
  echo "container script test failed: $*" >&2
  exit 1
}

assert_file_content() {
  local path="$1"
  local expected="$2"
  [[ -f "${path}" ]] || fail "missing file ${path}"
  [[ "$(cat "${path}")" == "${expected}" ]] || fail "unexpected content in ${path}"
}

fake_bin="${work_root}/bin"
fake_s3="${work_root}/s3"
bucket="fixture-bucket"
prefix="fixture/"
cluster_id="cluster-fixture"
cluster_root="${work_root}/efs/cluster-data"
efs_admin_root="${work_root}/efs"
mkdir -p "${fake_bin}" "${fake_s3}/${bucket}/${prefix}saves" "${work_root}/tmp"
ln -s "${repo_root}/test/fixtures/fake-aws.sh" "${fake_bin}/aws"
export PATH="${fake_bin}:${PATH}"
export FAKE_S3_ROOT="${fake_s3}"

legacy_root="${work_root}/legacy"
mkdir -p \
  "${legacy_root}/Saved/SavedArks" \
  "${legacy_root}/Saved/clusters/${cluster_id}" \
  "${legacy_root}/Saved/Config/WindowsServer" \
  "${fake_s3}/${bucket}/${prefix}config"
printf 'legacy-island-world\n' >"${legacy_root}/Saved/SavedArks/TheIsland_WP.ark"
printf 'survivor-v1\n' >"${legacy_root}/Saved/clusters/${cluster_id}/survivor.arkprofile"
printf '[ServerSettings]\nServerAdminPassword=legacy-secret\n' \
  >"${legacy_root}/Saved/Config/WindowsServer/GameUserSettings.ini"
tar --zstd -cf "${fake_s3}/${bucket}/${prefix}saves/current.tar.zst" -C "${legacy_root}" Saved
legacy_checksum="$(sha256sum "${fake_s3}/${bucket}/${prefix}saves/current.tar.zst" | cut -d' ' -f1)"
printf '[ServerSettings]\nCommonSetting=common\nPreventDownloadItems=True\n' \
  >"${fake_s3}/${bucket}/${prefix}config/GameUserSettings.ini"
printf '[/Script/ShooterGame.ShooterGameMode]\nCommonGameSetting=1\n' \
  >"${fake_s3}/${bucket}/${prefix}config/Game.ini"

migration_env=(
  S3_BUCKET="${bucket}"
  S3_RESOURCE_PREFIX="${prefix}"
  ASA_CLUSTER_ID="${cluster_id}"
  LEGACY_S3_SAVE_KEY="${prefix}saves/current.tar.zst"
  MIGRATION_MAP_IDS="the-island,scorched-earth"
  ASA_CLUSTER_DIR="${cluster_root}"
  EFS_ADMIN_ROOT="${efs_admin_root}"
  ASA_CLUSTER_PROBE=/bin/true
  ASA_TMP_ROOT="${work_root}/tmp"
)

env "${migration_env[@]}" bash "${repo_root}/container/migrate-storage.sh" migrate-parallel

[[ "$(sha256sum "${fake_s3}/${bucket}/${prefix}saves/current.tar.zst" | cut -d' ' -f1)" == "${legacy_checksum}" ]] \
  || fail "legacy archive was modified"
assert_file_content "${cluster_root}/${cluster_id}/survivor.arkprofile" "survivor-v1"
[[ "$(stat -c '%u:%g' "${cluster_root}/${cluster_id}")" == "10001:10001" ]] \
  || fail "migrated cluster directory is not owned by the runtime UID/GID"
setpriv --reuid=10001 --regid=10001 --clear-groups touch "${cluster_root}/${cluster_id}/.uid-write-probe"
rm -f "${cluster_root}/${cluster_id}/.uid-write-probe"

for map_id in the-island scorched-earth; do
  archive="${fake_s3}/${bucket}/${prefix}maps/${map_id}/saves/current.tar.zst"
  [[ -f "${archive}" ]] || fail "missing migrated archive for ${map_id}"
  if tar --zstd -tf "${archive}" | grep -Eq '^Saved/clusters(/|$)'; then
    fail "${map_id} archive still contains Cross-ARK cluster data"
  fi
  if tar --zstd -tf "${archive}" | grep -Eq '^Saved/Config/WindowsServer/(GameUserSettings.ini|Game.ini)$'; then
    fail "${map_id} migrated archive still contains runtime config or injected passwords"
  fi
  extracted="${work_root}/migrated-${map_id}"
  mkdir -p "${extracted}"
  tar --zstd -xf "${archive}" -C "${extracted}"
  assert_file_content "${extracted}/Saved/SavedArks/TheIsland_WP.ark" "legacy-island-world"
done

assert_file_content "${fake_s3}/${bucket}/${prefix}config/common/GameUserSettings.ini" $'[ServerSettings]\nCommonSetting=common\nPreventDownloadItems=True'
jq -e --arg clusterId "${cluster_id}" \
  '.schemaVersion == 2 and .clusterId == $clusterId and .mapIds == ["the-island", "scorched-earth"]' \
  "${fake_s3}/${bucket}/${prefix}migration/parallel-storage-v2.json" >/dev/null

if env "${migration_env[@]}" bash "${repo_root}/container/migrate-storage.sh" migrate-parallel >/dev/null 2>&1; then
  fail "migration overwrote an existing destination without explicit approval"
fi
env "${migration_env[@]}" MIGRATION_ALLOW_OVERWRITE=true bash "${repo_root}/container/migrate-storage.sh" migrate-parallel
pre_migration="$(find "${cluster_root}" -maxdepth 1 -type d -name ".pre-migration-${cluster_id}-*" -print -quit)"
[[ -n "${pre_migration}" ]] || fail "approved migration retry did not preserve the previous cluster directory"
assert_file_content "${pre_migration}/survivor.arkprofile" "survivor-v1"
[[ "$(stat -c '%u:%g' "${cluster_root}/${cluster_id}")" == "10001:10001" ]] \
  || fail "retried migration changed the runtime UID/GID"

mkdir -p "${fake_s3}/${bucket}/${prefix}config/maps/the-island"
printf '[ServerSettings]\nMapSetting=island\nPreventUploadItems=True\n' \
  >"${fake_s3}/${bucket}/${prefix}config/maps/the-island/GameUserSettings.ini"
printf '[/Script/ShooterGame.ShooterGameMode]\nMapGameSetting=2\n' \
  >"${fake_s3}/${bucket}/${prefix}config/maps/the-island/Game.ini"

restore_install="${work_root}/restore-install"
env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${prefix}maps/the-island/saves/current.tar.zst" \
  S3_COMMON_CONFIG_PREFIX="${prefix}config/common/" \
  S3_MAP_CONFIG_PREFIX="${prefix}config/maps/the-island/" \
  ASA_INSTALL_DIR="${restore_install}" \
  ASA_ADMIN_PASSWORD=admin-fixture \
  ASA_RCON_PORT=27020 \
  ASA_TMP_ROOT="${work_root}/restore-tmp" \
  bash "${repo_root}/container/restore.sh"

[[ ! -e "${restore_install}/ShooterGame/Saved/clusters" ]] || fail "restore reintroduced local cluster data"

new_world_install="${work_root}/new-world-install"
mkdir -p "${new_world_install}/ShooterGame/Saved/clusters/${cluster_id}"
printf 'image-local-cluster-data\n' >"${new_world_install}/ShooterGame/Saved/clusters/${cluster_id}/unsafe.dat"
env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${prefix}maps/new-world/saves/current.tar.zst" \
  S3_COMMON_CONFIG_PREFIX="${prefix}config/common/" \
  S3_MAP_CONFIG_PREFIX="${prefix}config/maps/new-world/" \
  ASA_INSTALL_DIR="${new_world_install}" \
  ASA_ADMIN_PASSWORD=admin-fixture \
  ASA_RCON_PORT=27020 \
  ASA_TMP_ROOT="${work_root}/new-world-tmp" \
  bash "${repo_root}/container/restore.sh"
[[ ! -e "${new_world_install}/ShooterGame/Saved/clusters" ]] || fail "new-world restore retained a local cluster fallback"

env \
  ASA_INSTALL_DIR="${restore_install}" \
  ASA_SESSION_NAME=fixture-the-island \
  ASA_SERVER_PASSWORD=server-fixture \
  ASA_ADMIN_PASSWORD=admin-fixture \
  ASA_RCON_PORT=27020 \
  python3 "${repo_root}/container/configure-server.py"

user_settings="${restore_install}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"
grep -Fqx 'CommonSetting=common' "${user_settings}" || fail "common config was not retained"
grep -Fqx 'MapSetting=island' "${user_settings}" || fail "Map overlay was not retained"
for forced_false in \
  noTributeDownloads \
  PreventDownloadDinos \
  PreventDownloadItems \
  PreventDownloadSurvivors \
  PreventUploadDinos \
  PreventUploadItems \
  PreventUploadSurvivors; do
  [[ "$(grep -Eic "^${forced_false}=" "${user_settings}")" == "1" ]] || fail "${forced_false} was missing or duplicated"
  grep -Fqxi "${forced_false}=False" "${user_settings}" || fail "${forced_false} did not force transfers on"
done
for expiration in \
  TributeCharacterExpirationSeconds=86400 \
  TributeDinoExpirationSeconds=86400 \
  TributeItemExpirationSeconds=86400 \
  MinimumDinoReuploadInterval=0; do
  grep -Fqx "${expiration}" "${user_settings}" || fail "cluster-wide expiration setting ${expiration} is missing"
done
grep -Fqx 'SessionName=fixture-the-island' "${user_settings}" || fail "forced session name was not applied"

backup_map() {
  local map_id="$1"
  local world_value="$2"
  local run_id="$3"
  local install_root="${work_root}/backup-${map_id}"
  mkdir -p \
    "${install_root}/ShooterGame/Saved/SavedArks" \
    "${install_root}/ShooterGame/Saved/clusters/${cluster_id}" \
    "${install_root}/ShooterGame/Saved/Config/WindowsServer"
  printf '%s\n' "${world_value}" >"${install_root}/ShooterGame/Saved/SavedArks/world.ark"
  printf 'must-not-be-archived\n' >"${install_root}/ShooterGame/Saved/clusters/${cluster_id}/transfer.dat"
  printf '[ServerSettings]\nServerAdminPassword=must-not-be-archived\n' \
    >"${install_root}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"
  printf '[/Script/ShooterGame.ShooterGameMode]\n' >"${install_root}/ShooterGame/Saved/Config/WindowsServer/Game.ini"
  env \
    S3_BUCKET="${bucket}" \
    S3_SAVE_KEY="${prefix}maps/${map_id}/saves/current.tar.zst" \
    S3_BACKUP_PREFIX="${prefix}maps/${map_id}/backups/" \
    S3_RUNTIME_PREFIX="${prefix}maps/${map_id}/runtime/" \
    ASA_INSTALL_DIR="${install_root}" \
    ASA_RUN_ID="${run_id}" \
    ASA_TMP_ROOT="${work_root}/backup-tmp-${map_id}" \
    SKIP_RCON_SAVE=true \
    BACKUP_QUIESCE_INTERVAL_SECONDS=0 \
    BACKUP_QUIESCE_TIMEOUT_SECONDS=1 \
    bash "${repo_root}/container/backup.sh"
}

backup_map the-island island-after-migration run-island-12345678
backup_map scorched-earth scorched-after-migration run-scorched-12345678
for map_id in the-island scorched-earth; do
  archive="${fake_s3}/${bucket}/${prefix}maps/${map_id}/saves/current.tar.zst"
  if tar --zstd -tf "${archive}" | grep -Eq '^Saved/clusters(/|$)'; then
    fail "backup for ${map_id} contains EFS cluster data"
  fi
  if tar --zstd -tf "${archive}" | grep -Eq '^Saved/Config/WindowsServer/(GameUserSettings.ini|Game.ini)$'; then
    fail "backup for ${map_id} contains runtime config or injected passwords"
  fi
  extracted="${work_root}/backup-extract-${map_id}"
  mkdir -p "${extracted}"
  tar --zstd -xf "${archive}" -C "${extracted}"
  expected_world="island-after-migration"
  expected_run="run-island-12345678"
  if [[ "${map_id}" == "scorched-earth" ]]; then
    expected_world="scorched-after-migration"
    expected_run="run-scorched-12345678"
  fi
  assert_file_content "${extracted}/Saved/SavedArks/world.ark" "${expected_world}"
  jq -e --arg runId "${expected_run}" '.runId == $runId' \
    "${fake_s3}/${bucket}/${prefix}maps/${map_id}/runtime/last-backup.json" >/dev/null
done

env \
  "${migration_env[@]}" \
  ROLLBACK_MAP_ID=the-island \
  ROLLBACK_S3_SAVE_KEY="${prefix}rollback-rehearsal/current.tar.zst" \
  bash "${repo_root}/container/migrate-storage.sh" export-legacy
rollback_archive="${fake_s3}/${bucket}/${prefix}rollback-rehearsal/current.tar.zst"
rollback_extract="${work_root}/rollback-extract"
mkdir -p "${rollback_extract}"
tar --zstd -xf "${rollback_archive}" -C "${rollback_extract}"
assert_file_content "${rollback_extract}/Saved/SavedArks/world.ark" "island-after-migration"
assert_file_content "${rollback_extract}/Saved/clusters/${cluster_id}/survivor.arkprofile" "survivor-v1"

restored_relative="aws-backup-restore_20260719T000000Z/cluster-data/${cluster_id}"
mkdir -p "${efs_admin_root}/${restored_relative}"
printf 'survivor-recovered\n' >"${efs_admin_root}/${restored_relative}/survivor.arkprofile"
restore_env=(
  "${migration_env[@]}"
  RESTORED_CLUSTER_PATH="${restored_relative}"
)
if env "${restore_env[@]}" bash "${repo_root}/container/migrate-storage.sh" restore-cluster >/dev/null 2>&1; then
  fail "restore replaced live cluster data without explicit approval"
fi
env "${restore_env[@]}" MIGRATION_ALLOW_OVERWRITE=true bash "${repo_root}/container/migrate-storage.sh" restore-cluster
assert_file_content "${cluster_root}/${cluster_id}/survivor.arkprofile" "survivor-recovered"
[[ "$(stat -c '%u:%g' "${cluster_root}/${cluster_id}")" == "10001:10001" ]] \
  || fail "restored cluster directory is not owned by the runtime UID/GID"
preserved="$(find "${cluster_root}" -maxdepth 1 -type d -name ".pre-restore-${cluster_id}-*" -print -quit)"
[[ -n "${preserved}" ]] || fail "restore did not preserve the previous live cluster directory"
assert_file_content "${preserved}/survivor.arkprofile" "survivor-v1"

normal_directory="${work_root}/not-a-mount"
mkdir -p "${normal_directory}"
if ASA_CLUSTER_DIR="${normal_directory}" bash "${repo_root}/container/cluster-probe.sh" >/dev/null 2>&1; then
  fail "cluster probe accepted an ordinary directory"
fi
if env "${migration_env[@]}" ASA_CLUSTER_ID='../escape' bash "${repo_root}/container/migrate-storage.sh" migrate-parallel >/dev/null 2>&1; then
  fail "migration accepted a path-traversing cluster ID"
fi

unsafe_root="${work_root}/unsafe"
mkdir -p "${unsafe_root}/Other"
printf 'unsafe\n' >"${unsafe_root}/Other/file.txt"
tar --zstd -cf "${fake_s3}/${bucket}/${prefix}maps/the-island/saves/unsafe.tar.zst" -C "${unsafe_root}" Other
if env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${prefix}maps/the-island/saves/unsafe.tar.zst" \
  S3_COMMON_CONFIG_PREFIX="${prefix}config/common/" \
  S3_MAP_CONFIG_PREFIX="${prefix}config/maps/the-island/" \
  ASA_INSTALL_DIR="${work_root}/unsafe-install" \
  ASA_ADMIN_PASSWORD=admin-fixture \
  ASA_RCON_PORT=27020 \
  ASA_TMP_ROOT="${work_root}/unsafe-tmp" \
  bash "${repo_root}/container/restore.sh" >/dev/null 2>&1; then
  fail "restore accepted an archive outside Saved/"
fi

linked_root="${work_root}/linked"
mkdir -p "${linked_root}/Saved"
ln -s /tmp "${linked_root}/Saved/external-link"
tar --zstd -cf "${fake_s3}/${bucket}/${prefix}maps/the-island/saves/linked.tar.zst" -C "${linked_root}" Saved
if env \
  S3_BUCKET="${bucket}" \
  S3_SAVE_KEY="${prefix}maps/the-island/saves/linked.tar.zst" \
  S3_COMMON_CONFIG_PREFIX="${prefix}config/common/" \
  S3_MAP_CONFIG_PREFIX="${prefix}config/maps/the-island/" \
  ASA_INSTALL_DIR="${work_root}/linked-install" \
  ASA_ADMIN_PASSWORD=admin-fixture \
  ASA_RCON_PORT=27020 \
  ASA_TMP_ROOT="${work_root}/linked-tmp" \
  bash "${repo_root}/container/restore.sh" >/dev/null 2>&1; then
  fail "restore accepted an archive containing a symbolic link"
fi

wrapper_log="${work_root}/wrapper-aws.log"
export FAKE_AWS_LOG="${wrapper_log}"
if bash "${repo_root}/scripts/run-storage-migration.sh" \
  --stack-name fixture-stack \
  --mode migrate-parallel \
  --cluster-id "${cluster_id}" \
  --maps the-island,the-island >/dev/null 2>&1; then
  fail "migration wrapper accepted duplicate map IDs"
fi
bash "${repo_root}/scripts/run-storage-migration.sh" \
  --stack-name fixture-stack \
  --mode migrate-parallel \
  --cluster-id "${cluster_id}" \
  --maps the-island,scorched-earth
grep -Fq 'ecs run-task' "${wrapper_log}" || fail "migration wrapper did not start the dedicated task"
grep -Fq '"name":"ASA_OPERATION_MODE","value":"migrate-parallel"' "${wrapper_log}" \
  || fail "migration wrapper did not pass the selected operation mode"
grep -Fq '"name":"MIGRATION_MAP_IDS","value":"the-island,scorched-earth"' "${wrapper_log}" \
  || fail "migration wrapper did not pass the Map set"
grep -Fq 'dynamodb update-item' "${wrapper_log}" || fail "migration wrapper did not initialize schema v2"
unset FAKE_AWS_LOG

echo "Container storage and migration script assertions passed."
