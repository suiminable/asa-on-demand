#!/usr/bin/env bash
set -euo pipefail

pgrep -f ArkAscendedServer.exe >/dev/null
timeout "${CLUSTER_PROBE_TIMEOUT_SECONDS:-5}" /asa/scripts/cluster-probe.sh
