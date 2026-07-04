#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--profile PROFILE] [--region REGION] [--resource-prefix PREFIX] [--build-id TAG]" >&2
}

PROFILE=""
REGION="ap-northeast-1"
RESOURCE_PREFIX=""
BUILD_ID="initial"

while (($# > 0)); do
  case "$1" in
    --profile | --region | --resource-prefix | --build-id)
      if (($# < 2)); then
        echo "$1 requires a value." >&2
        usage
        exit 2
      fi
      case "$1" in
        --profile) PROFILE="$2" ;;
        --region) REGION="$2" ;;
        --resource-prefix) RESOURCE_PREFIX="$2" ;;
        --build-id) BUILD_ID="$2" ;;
      esac
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${REGION}" ]]; then
  echo "--region must not be empty." >&2
  exit 2
fi

if [[ ! "${BUILD_ID}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "--build-id must be a valid ECR image tag." >&2
  exit 2
fi

AWS_ARGS=(--region "${REGION}")
if [[ -n "${PROFILE}" ]]; then
  AWS_ARGS+=(--profile "${PROFILE}")
fi

aws_cli() {
  aws "${AWS_ARGS[@]}" "$@"
}

# Keep this normalization in sync with normalizeNameSegment in asa-fargate-stack.ts.
trimmed_prefix="$(printf '%s' "${RESOURCE_PREFIX}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s|^/+||; s|/+$||')"
if [[ -n "${trimmed_prefix}" && ! "${trimmed_prefix}" =~ ^[A-Za-z0-9_./-]+$ ]]; then
  echo "--resource-prefix must contain only letters, numbers, slash, dot, underscore, or hyphen." >&2
  exit 2
fi

if [[ -z "${trimmed_prefix}" ]]; then
  repository_name="asa-server"
else
  name_segment="$(printf '%s' "${trimmed_prefix}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//')"
  name_segment="${name_segment:-default}"
  repository_name="asa-${name_segment}-server"
fi

account_id="$(aws_cli sts get-caller-identity --query Account --output text)"
if [[ ! "${account_id}" =~ ^[0-9]{12}$ ]]; then
  echo "Unable to determine the AWS account ID." >&2
  exit 1
fi

registry="${account_id}.dkr.ecr.${REGION}.amazonaws.com"
image="${registry}/${repository_name}:${BUILD_ID}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"

echo "Logging in to ${registry}"
aws_cli ecr get-login-password | docker login --username AWS --password-stdin "${registry}"

echo "Building ${image}"
docker build --build-arg "ASA_BUILD_ID=${BUILD_ID}" -t "${image}" "${repository_root}/container"

echo "Pushing ${image}"
docker push "${image}"
