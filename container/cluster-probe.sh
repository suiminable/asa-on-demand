#!/usr/bin/env bash
set -euo pipefail

cluster_dir="${ASA_CLUSTER_DIR:-/asa/cluster}"
probe_id="${ASA_RUN_ID:-health}-$$-${RANDOM}"
source_file="${cluster_dir}/.asa-probe-${probe_id}"
renamed_file="${source_file}.renamed"

mountpoint -q "${cluster_dir}"
printf '%s\n' "${probe_id}" >"${source_file}"
grep -Fxq "${probe_id}" "${source_file}"
mv "${source_file}" "${renamed_file}"
rm -f "${renamed_file}"
