#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${ASA_CLUSTER_ID:?ASA_CLUSTER_ID is required}"
: "${LEGACY_S3_SAVE_KEY:?LEGACY_S3_SAVE_KEY is required}"

cluster_root="${ASA_CLUSTER_DIR:-/asa/cluster}"
efs_admin_root="${EFS_ADMIN_ROOT:-${cluster_root}}"
scripts_root="${ASA_SCRIPTS_DIR:-/asa/scripts}"
tmp_root="${ASA_TMP_ROOT:-/asa/tmp}"
cluster_probe="${ASA_CLUSTER_PROBE:-${scripts_root}/cluster-probe.sh}"
target_uid="${MIGRATION_TARGET_UID:-10001}"
target_gid="${MIGRATION_TARGET_GID:-10001}"
resource_prefix="${S3_RESOURCE_PREFIX:-}"
resource_prefix="${resource_prefix#/}"
if [[ -n "${resource_prefix}" && "${resource_prefix}" != */ ]]; then resource_prefix="${resource_prefix}/"; fi

if [[ ! "${ASA_CLUSTER_ID}" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
  echo "ASA_CLUSTER_ID contains unsupported characters." >&2
  exit 2
fi
if [[ ! "${target_uid}" =~ ^[0-9]+$ || ! "${target_gid}" =~ ^[0-9]+$ ]]; then
  echo "Migration target UID/GID must be numeric." >&2
  exit 2
fi
for efs_path in "${cluster_root}" "${efs_admin_root}"; do
  if [[ "${efs_path}" != /* || "${efs_path}" == "/" || "${efs_path}" == *"/../"* || "${efs_path}" == */.. ]]; then
    echo "Migration EFS paths must be absolute, scoped directories without parent traversal." >&2
    exit 2
  fi
done
if [[ "${cluster_root}" != "${efs_admin_root}" && "${cluster_root}" != "${efs_admin_root%/}/"* ]]; then
  echo "ASA_CLUSTER_DIR must be EFS_ADMIN_ROOT or one of its descendants." >&2
  exit 2
fi

if ! ASA_CLUSTER_DIR="${efs_admin_root}" timeout "${CLUSTER_PROBE_TIMEOUT_SECONDS:-5}" "${cluster_probe}"; then
  echo "Migration requires the writable EFS mount at ${efs_admin_root}." >&2
  exit 1
fi
mkdir -p "${cluster_root}"
chown "${target_uid}:${target_gid}" "${cluster_root}"
chmod 0750 "${cluster_root}"

mkdir -p "${tmp_root}"
work_dir="$(mktemp -d "${tmp_root%/}/storage-migration.XXXXXX")"
efs_stage=""
cleanup() {
  rm -rf -- "${work_dir}"
  if [[ -n "${efs_stage}" && "${efs_stage}" == "${cluster_root}"/.asa-*-stage-* ]]; then
    rm -rf -- "${efs_stage}"
  fi
}
trap cleanup EXIT

safe_extract() {
  local archive="$1"
  local destination="$2"
  tar --zstd -tf "${archive}" >"${work_dir}/archive-files.txt"
  tar --zstd -tvf "${archive}" >"${work_dir}/archive-types.txt"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "${work_dir}/archive-files.txt"; then
    echo "Archive contains an unsafe path." >&2
    exit 1
  fi
  if grep -Evq '^Saved(/|$)' "${work_dir}/archive-files.txt"; then
    echo "Archive contains entries outside Saved/." >&2
    exit 1
  fi
  if ! grep -Eq '^Saved(/|$)' "${work_dir}/archive-files.txt"; then
    echo "Archive does not contain Saved/." >&2
    exit 1
  fi
  if awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { unsafe = 1 } END { exit unsafe ? 0 : 1 }' \
    "${work_dir}/archive-types.txt"; then
    echo "Archive contains a link, device, or another unsupported entry type." >&2
    exit 1
  fi
  mkdir -p "${destination}"
  tar --zstd -xf "${archive}" -C "${destination}"
}

object_exists() {
  aws s3api head-object --bucket "${S3_BUCKET}" --key "$1" >/dev/null 2>&1
}

require_new_object() {
  local key="$1"
  if object_exists "${key}" && [[ "${MIGRATION_ALLOW_OVERWRITE:-false}" != "true" ]]; then
    echo "Refusing to overwrite s3://${S3_BUCKET}/${key}; set MIGRATION_ALLOW_OVERWRITE=true only after taking a backup." >&2
    exit 1
  fi
}

case "${mode}" in
  migrate-parallel)
    : "${MIGRATION_MAP_IDS:?MIGRATION_MAP_IDS is required (comma-separated mapId values)}"
    if [[ ! "${MIGRATION_MAP_IDS}" =~ ^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$ ]]; then
      echo "MIGRATION_MAP_IDS must be a comma-separated list of mapId values without whitespace or empty entries." >&2
      exit 2
    fi
    marker_key="${resource_prefix}migration/parallel-storage-v2.json"
    if object_exists "${marker_key}" && [[ "${MIGRATION_ALLOW_OVERWRITE:-false}" != "true" ]]; then
      echo "Migration marker already exists: s3://${S3_BUCKET}/${marker_key}" >&2
      exit 1
    fi
    aws s3 cp "s3://${S3_BUCKET}/${LEGACY_S3_SAVE_KEY}" "${work_dir}/legacy.tar.zst"
    safe_extract "${work_dir}/legacy.tar.zst" "${work_dir}/legacy"

    cluster_source="${work_dir}/legacy/Saved/clusters/${ASA_CLUSTER_ID}"
    if [[ ! -d "${cluster_source}" ]]; then
      echo "Legacy archive does not contain Saved/clusters/${ASA_CLUSTER_ID}. Inspect the real archive before changing the split rule." >&2
      exit 1
    fi
    cluster_destination="${cluster_root}/${ASA_CLUSTER_ID}"
    if [[ -e "${cluster_destination}" && ! -d "${cluster_destination}" ]]; then
      echo "EFS cluster destination is not a directory: ${cluster_destination}" >&2
      exit 1
    fi
    if [[ -e "${cluster_destination}" && -n "$(find "${cluster_destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      if [[ "${MIGRATION_ALLOW_OVERWRITE:-false}" != "true" ]]; then
        echo "Refusing to replace non-empty EFS cluster directory: ${cluster_destination}" >&2
        exit 1
      fi
    fi

    IFS=',' read -r -a map_ids <<<"${MIGRATION_MAP_IDS}"
    if (( ${#map_ids[@]} == 0 )); then
      echo "At least one mapId is required." >&2
      exit 1
    fi
    declare -A seen_map_ids=()
    for map_id in "${map_ids[@]}"; do
      if [[ ! "${map_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
        echo "Invalid mapId: ${map_id}" >&2
        exit 1
      fi
      if [[ -n "${seen_map_ids[${map_id}]:-}" ]]; then
        echo "Duplicate mapId: ${map_id}" >&2
        exit 1
      fi
      seen_map_ids["${map_id}"]=1
      require_new_object "${resource_prefix}maps/${map_id}/saves/current.tar.zst"
    done

    efs_stage="${cluster_root}/.asa-migration-stage-${ASA_CLUSTER_ID}-$$"
    mkdir "${efs_stage}"
    cp -a "${cluster_source}/." "${efs_stage}/"
    chown -R "${target_uid}:${target_gid}" "${efs_stage}"
    chmod 0750 "${efs_stage}"
    rm -rf -- "${work_dir}/legacy/Saved/clusters"
    rm -f -- \
      "${work_dir}/legacy/Saved/Config/WindowsServer/GameUserSettings.ini" \
      "${work_dir}/legacy/Saved/Config/WindowsServer/Game.ini"
    tar --zstd -cf "${work_dir}/map-save.tar.zst" -C "${work_dir}/legacy" Saved
    for map_id in "${map_ids[@]}"; do
      aws s3 cp "${work_dir}/map-save.tar.zst" "s3://${S3_BUCKET}/${resource_prefix}maps/${map_id}/saves/current.tar.zst"
    done

    for config_name in GameUserSettings.ini Game.ini; do
      legacy_config_key="${resource_prefix}config/${config_name}"
      common_config_key="${resource_prefix}config/common/${config_name}"
      if object_exists "${legacy_config_key}"; then
        require_new_object "${common_config_key}"
        aws s3 cp "s3://${S3_BUCKET}/${legacy_config_key}" "s3://${S3_BUCKET}/${common_config_key}"
      fi
    done

    if [[ -d "${cluster_destination}" ]]; then
      if [[ -n "$(find "${cluster_destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        preserved="${cluster_root}/.pre-migration-${ASA_CLUSTER_ID}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        mv "${cluster_destination}" "${preserved}"
        echo "Preserved the previous cluster directory at ${preserved}."
      else
        rmdir "${cluster_destination}"
      fi
    fi
    mv "${efs_stage}" "${cluster_destination}"
    efs_stage=""

    jq -n \
      --arg migratedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg legacySaveKey "${LEGACY_S3_SAVE_KEY}" \
      --arg clusterId "${ASA_CLUSTER_ID}" \
      --arg mapIds "${MIGRATION_MAP_IDS}" \
      '{schemaVersion: 2, migratedAt: $migratedAt, legacySaveKey: $legacySaveKey, clusterId: $clusterId, mapIds: ($mapIds | split(","))}' \
      | aws s3 cp - "s3://${S3_BUCKET}/${marker_key}" --content-type application/json
    echo "Parallel storage migration completed. Legacy object was not deleted."
    ;;

  export-legacy)
    : "${ROLLBACK_MAP_ID:?ROLLBACK_MAP_ID is required}"
    if [[ ! "${ROLLBACK_MAP_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
      echo "Invalid rollback mapId: ${ROLLBACK_MAP_ID}" >&2
      exit 2
    fi
    rollback_source_key="${resource_prefix}maps/${ROLLBACK_MAP_ID}/saves/current.tar.zst"
    rollback_output_key="${ROLLBACK_S3_SAVE_KEY:-${LEGACY_S3_SAVE_KEY}}"
    require_new_object "${rollback_output_key}"
    cluster_source="${cluster_root}/${ASA_CLUSTER_ID}"
    if [[ ! -d "${cluster_source}" ]]; then
      echo "EFS cluster directory does not exist: ${cluster_source}" >&2
      exit 1
    fi
    aws s3 cp "s3://${S3_BUCKET}/${rollback_source_key}" "${work_dir}/map-save.tar.zst"
    safe_extract "${work_dir}/map-save.tar.zst" "${work_dir}/rollback"
    rm -rf -- "${work_dir}/rollback/Saved/clusters"
    mkdir -p "${work_dir}/rollback/Saved/clusters/${ASA_CLUSTER_ID}"
    cp -a "${cluster_source}/." "${work_dir}/rollback/Saved/clusters/${ASA_CLUSTER_ID}/"
    tar --zstd -cf "${work_dir}/legacy-export.tar.zst" -C "${work_dir}/rollback" Saved
    aws s3 cp "${work_dir}/legacy-export.tar.zst" "s3://${S3_BUCKET}/${rollback_output_key}"
    echo "Legacy rollback archive exported to s3://${S3_BUCKET}/${rollback_output_key}."
    ;;

  restore-cluster)
    : "${RESTORED_CLUSTER_PATH:?RESTORED_CLUSTER_PATH is required}"
    restored_parent="${RESTORED_CLUSTER_PATH%/cluster-data/${ASA_CLUSTER_ID}}"
    if [[ "${restored_parent}" == "${RESTORED_CLUSTER_PATH}" || ! "${restored_parent}" =~ ^aws-backup-restore_[A-Za-z0-9_.:-]+$ ]]; then
      echo "RESTORED_CLUSTER_PATH must identify aws-backup-restore_*/cluster-data/${ASA_CLUSTER_ID}." >&2
      exit 2
    fi
    restore_source="${efs_admin_root}/${RESTORED_CLUSTER_PATH}"
    cluster_destination="${cluster_root}/${ASA_CLUSTER_ID}"
    if [[ ! -d "${restore_source}" ]]; then
      echo "Restored cluster directory does not exist: ${restore_source}" >&2
      exit 1
    fi
    if [[ -e "${cluster_destination}" && ! -d "${cluster_destination}" ]]; then
      echo "EFS cluster destination is not a directory: ${cluster_destination}" >&2
      exit 1
    fi
    if [[ -e "${cluster_destination}" && -n "$(find "${cluster_destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      if [[ "${MIGRATION_ALLOW_OVERWRITE:-false}" != "true" ]]; then
        echo "Refusing to replace ${cluster_destination}; re-run with --allow-overwrite after verifying the recovery directory." >&2
        exit 1
      fi
    fi
    efs_stage="${cluster_root}/.asa-restore-stage-${ASA_CLUSTER_ID}-$$"
    mkdir "${efs_stage}"
    cp -a "${restore_source}/." "${efs_stage}/"
    chown -R "${target_uid}:${target_gid}" "${efs_stage}"
    chmod 0750 "${efs_stage}"
    if [[ -d "${cluster_destination}" ]]; then
      if [[ -n "$(find "${cluster_destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        preserved="${cluster_root}/.pre-restore-${ASA_CLUSTER_ID}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        mv "${cluster_destination}" "${preserved}"
        echo "Preserved the previous cluster directory at ${preserved}."
      else
        rmdir "${cluster_destination}"
      fi
    fi
    mv "${efs_stage}" "${cluster_destination}"
    efs_stage=""
    echo "Restored cluster data promoted from ${RESTORED_CLUSTER_PATH}."
    ;;

  *)
    echo "ASA_OPERATION_MODE must be migrate-parallel, export-legacy, or restore-cluster." >&2
    exit 2
    ;;
esac
