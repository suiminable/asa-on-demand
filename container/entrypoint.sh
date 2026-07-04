#!/usr/bin/env bash
set -euo pipefail

required=(
  AWS_REGION
  S3_BUCKET
  S3_SAVE_KEY
  S3_BACKUP_PREFIX
  ASA_APP_ID
  ASA_INSTALL_DIR
  ASA_MAP
  ASA_SESSION_NAME
  ASA_MAX_PLAYERS
  ASA_SERVER_PASSWORD
  ASA_ADMIN_PASSWORD
  ASA_PORT
  ASA_RCON_PORT
  ASA_CLUSTER_ID
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 2
  fi
done

if [[ ! "${ASA_SESSION_NAME}" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
  echo "ASA_SESSION_NAME contains unsupported characters." >&2
  exit 2
fi
if [[ ! "${ASA_CLUSTER_ID}" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
  echo "ASA_CLUSTER_ID contains unsupported characters." >&2
  exit 2
fi

mkdir -p /asa/server /asa/work /asa/tmp /asa/scripts

asa_pid=""
backup_loop_pid=""
request_loop_pid=""
stopping="false"

notify() {
  local content
  content="$(printf '%b' "$1")"
  /asa/scripts/notify-discord.sh "${content}" || true
}

run_backup() {
  SKIP_RCON_SAVE="${1:-false}" /asa/scripts/backup.sh || notify "ASA backup failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
}

stop_background_loops() {
  if [[ -n "${backup_loop_pid}" ]]; then kill "${backup_loop_pid}" 2>/dev/null || true; fi
  if [[ -n "${request_loop_pid}" ]]; then kill "${request_loop_pid}" 2>/dev/null || true; fi
}

shutdown() {
  if [[ "${stopping}" == "true" ]]; then return; fi
  stopping="true"
  notify "ASA server is stopping. Saving world and uploading final backup..."
  stop_background_loops
  if [[ -n "${asa_pid}" ]]; then
    /asa/scripts/rcon.py SaveWorld || true
    sleep "${BACKUP_SAVE_DELAY_SECONDS:-8}"
    /asa/scripts/rcon.py DoExit || kill -TERM "${asa_pid}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if ! kill -0 "${asa_pid}" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "${asa_pid}" 2>/dev/null; then
      kill -TERM "${asa_pid}" 2>/dev/null || true
      sleep 5
    fi
    kill -KILL "${asa_pid}" 2>/dev/null || true
  fi
  run_backup true
}

trap shutdown SIGTERM SIGINT

if [[ "${ASA_UPDATE_ON_START:-false}" == "true" ]]; then
  echo "Updating ASA dedicated server with SteamCMD..."
  steamcmd +force_install_dir "${ASA_INSTALL_DIR}" +login anonymous +app_update "${ASA_APP_ID}" validate +quit
else
  echo "Using ASA dedicated server bundled in the container image."
fi

/asa/scripts/restore.sh
/asa/scripts/configure-server.py

server_exe="${ASA_INSTALL_DIR}/ShooterGame/Binaries/Win64/ArkAscendedServer.exe"
if [[ ! -f "${server_exe}" ]]; then
  echo "ASA server executable not found: ${server_exe}" >&2
  exit 1
fi

# Steam currently ships this DLL with ASA, but it crashes when loaded through Proton.
rm -f "${ASA_INSTALL_DIR}/ShooterGame/Binaries/Win64/steamclient64.dll"

cluster_dir="${ASA_INSTALL_DIR}/ShooterGame/Saved/clusters"
cluster_dir_windows="Z:${cluster_dir//\//\\}"
mkdir -p "${cluster_dir}"

launch_arg="${ASA_MAP}?listen?Port=${ASA_PORT}"
extra_args=(-log "-WinLiveMaxPlayers=${ASA_MAX_PLAYERS}" "-clusterid=${ASA_CLUSTER_ID}" "-ClusterDirOverride=${cluster_dir_windows}")
if [[ "${ASA_DISABLE_BATTLEYE:-true}" == "true" ]]; then
  extra_args+=(-NoBattlEye)
fi

if [[ -x "${PROTONPATH:-}/proton" ]]; then
  export STEAM_COMPAT_CLIENT_INSTALL_PATH="${STEAM_COMPAT_CLIENT_INSTALL_PATH:-/home/asa/.local/share/Steam}"
  export STEAM_COMPAT_DATA_PATH="${STEAM_COMPAT_DATA_PATH:-${WINEPREFIX}}"
  export STEAM_COMPAT_INSTALL_PATH="${STEAM_COMPAT_INSTALL_PATH:-${ASA_INSTALL_DIR}}"
  export SteamAppId="${ASA_APP_ID}"
  export SteamGameId="${ASA_APP_ID}"
  mkdir -p "${STEAM_COMPAT_CLIENT_INSTALL_PATH}" "${STEAM_COMPAT_DATA_PATH}"
  launcher=("${PROTONPATH}/proton" run "${server_exe}")
elif command -v umu-run >/dev/null 2>&1; then
  launcher=(umu-run "${server_exe}")
elif command -v proton >/dev/null 2>&1; then
  launcher=(proton run "${server_exe}")
else
  echo "No UMU or Proton launcher found in PATH." >&2
  exit 1
fi

echo "Starting ASA server..."
"${launcher[@]}" "${launch_arg}" "${extra_args[@]}" &
asa_pid="$!"

(
  interval="${AUTO_BACKUP_INTERVAL_SECONDS:-600}"
  while true; do
    sleep "${interval}"
    run_backup
  done
) &
backup_loop_pid="$!"

(
  key="${BACKUP_REQUEST_KEY:-runtime/backup-request.json}"
  last_seen=""
  while true; do
    request="$(aws s3 cp "s3://${S3_BUCKET}/${key}" - 2>/dev/null || true)"
    requested_at="$(jq -r '.requestedAt // empty' <<<"${request}" 2>/dev/null || true)"
    if [[ -n "${requested_at}" && "${requested_at}" != "${last_seen}" ]]; then
      last_seen="${requested_at}"
      run_backup
    fi
    sleep 30
  done
) &
request_loop_pid="$!"

(
  for _ in $(seq 1 120); do
    if nc -z -w1 127.0.0.1 "${ASA_RCON_PORT}" >/dev/null 2>&1; then
      notify "ASA server is READY.\nServer: ${ASA_SESSION_NAME}\nMap: ${ASA_MAP}\nAuto-stop: ${ASA_EXPIRES_AT:-unknown}"
      exit 0
    fi
    sleep 10
  done
  notify "ASA server did not pass the ready check within the expected window. It may still finish loading."
) &

exit_code=0
wait "${asa_pid}" || exit_code="$?"
stop_background_loops
exit "${exit_code}"
