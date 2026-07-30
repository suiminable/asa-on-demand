#!/usr/bin/env bash
set -euo pipefail

# Minimal transparent filter for running shell tests on hosts without zstd.
# Container tests use the real zstd binary from the production image.
cat
