#!/usr/bin/env bash
set -euo pipefail

: "${REAL_TAR_BIN:?REAL_TAR_BIN is required}"

failures="${FAKE_TAR_SNAPSHOT_FAILURES:-0}"
if [[ "${1:-}" == "-cf" && "${2:-}" == "-" && "${failures}" =~ ^[0-9]+$ && "${failures}" -gt 0 ]]; then
  : "${FAKE_TAR_FAILURE_STATE:?FAKE_TAR_FAILURE_STATE is required when failures are enabled}"
  failure_count=0
  if [[ -f "${FAKE_TAR_FAILURE_STATE}" ]]; then
    failure_count="$(<"${FAKE_TAR_FAILURE_STATE}")"
  fi
  if (( failure_count < failures )); then
    printf '%d\n' "$(( failure_count + 1 ))" >"${FAKE_TAR_FAILURE_STATE}"
    echo "Simulated save snapshot race." >&2
    exit 1
  fi
fi

exec "${REAL_TAR_BIN}" "$@"
