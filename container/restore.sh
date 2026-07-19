#!/usr/bin/env bash
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_SAVE_KEY:?S3_SAVE_KEY is required}"
: "${S3_COMMON_CONFIG_PREFIX:?S3_COMMON_CONFIG_PREFIX is required}"
: "${S3_MAP_CONFIG_PREFIX:?S3_MAP_CONFIG_PREFIX is required}"
: "${ASA_INSTALL_DIR:?ASA_INSTALL_DIR is required}"

tmp_root="${ASA_TMP_ROOT:-/asa/tmp}"
mkdir -p "${tmp_root}"
current_archive="${tmp_root%/}/current.tar.zst"
current_files="${tmp_root%/}/current-files.txt"
current_types="${tmp_root%/}/current-types.txt"
map_user_settings="${tmp_root%/}/map-GameUserSettings.ini"
map_game="${tmp_root%/}/map-Game.ini"
mkdir -p "${ASA_INSTALL_DIR}/ShooterGame"

if aws s3 cp "s3://${S3_BUCKET}/${S3_SAVE_KEY}" "${current_archive}"; then
  tar --zstd -tf "${current_archive}" >"${current_files}"
  tar --zstd -tvf "${current_archive}" >"${current_types}"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "${current_files}" || grep -Evq '^Saved(/|$)' "${current_files}" || ! grep -Eq '^Saved(/|$)' "${current_files}"; then
    echo "Map save archive contains an unsafe or unexpected path." >&2
    exit 1
  fi
  if awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { unsafe = 1 } END { exit unsafe ? 0 : 1 }' \
    "${current_types}"; then
    echo "Map save archive contains a link, device, or another unsupported entry type." >&2
    exit 1
  fi
  tar --zstd -xf "${current_archive}" -C "${ASA_INSTALL_DIR}/ShooterGame"
else
  echo "No existing save archive found. Starting a new world."
fi

# Cross-ARK data must never fall back to the image or ephemeral Saved tree,
# including on the first boot where no Map archive exists yet.
rm -rf -- "${ASA_INSTALL_DIR}/ShooterGame/Saved/clusters"
mkdir -p "${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer"

if ! aws s3 cp "s3://${S3_BUCKET}/${S3_COMMON_CONFIG_PREFIX}GameUserSettings.ini" "${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"; then
  cat >"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini" <<EOF
[ServerSettings]
ServerAdminPassword=${ASA_ADMIN_PASSWORD}
RCONEnabled=True
RCONPort=${ASA_RCON_PORT}
EOF
fi
if aws s3 cp "s3://${S3_BUCKET}/${S3_MAP_CONFIG_PREFIX}GameUserSettings.ini" "${map_user_settings}"; then
  printf '\n' >>"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"
  cat "${map_user_settings}" >>"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"
fi

if ! aws s3 cp "s3://${S3_BUCKET}/${S3_COMMON_CONFIG_PREFIX}Game.ini" "${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/Game.ini"; then
  cat >"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/Game.ini" <<EOF
[/Script/ShooterGame.ShooterGameMode]
EOF
fi
if aws s3 cp "s3://${S3_BUCKET}/${S3_MAP_CONFIG_PREFIX}Game.ini" "${map_game}"; then
  printf '\n' >>"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/Game.ini"
  cat "${map_game}" >>"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/Game.ini"
fi
