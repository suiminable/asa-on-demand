#!/usr/bin/env bash
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_SAVE_KEY:?S3_SAVE_KEY is required}"
: "${ASA_INSTALL_DIR:?ASA_INSTALL_DIR is required}"

S3_CONFIG_PREFIX="${S3_CONFIG_PREFIX:-config/}"
mkdir -p "${ASA_INSTALL_DIR}/ShooterGame"

if aws s3 cp "s3://${S3_BUCKET}/${S3_SAVE_KEY}" /asa/tmp/current.tar.zst; then
  tar --zstd -xf /asa/tmp/current.tar.zst -C "${ASA_INSTALL_DIR}/ShooterGame"
else
  echo "No existing save archive found. Starting a new world."
fi

mkdir -p "${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer"

if ! aws s3 cp "s3://${S3_BUCKET}/${S3_CONFIG_PREFIX}GameUserSettings.ini" "${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"; then
  cat >"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini" <<EOF
[ServerSettings]
ServerAdminPassword=${ASA_ADMIN_PASSWORD}
RCONEnabled=True
RCONPort=${ASA_RCON_PORT}
EOF
fi

if ! aws s3 cp "s3://${S3_BUCKET}/${S3_CONFIG_PREFIX}Game.ini" "${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/Game.ini"; then
  cat >"${ASA_INSTALL_DIR}/ShooterGame/Saved/Config/WindowsServer/Game.ini" <<EOF
[/Script/ShooterGame.ShooterGameMode]
EOF
fi
