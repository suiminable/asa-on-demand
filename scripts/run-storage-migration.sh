#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec pnpm --dir "${repo_root}" exec tsx "${repo_root}/scripts/storage-migration.ts" "$@"
