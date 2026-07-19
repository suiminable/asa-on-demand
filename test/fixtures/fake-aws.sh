#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_S3_ROOT:?FAKE_S3_ROOT is required}"

if [[ -n "${FAKE_AWS_LOG:-}" ]]; then
  printf '%s ' "$@" >>"${FAKE_AWS_LOG}"
  printf '\n' >>"${FAKE_AWS_LOG}"
fi

s3_path() {
  local uri="$1"
  local value="${uri#s3://}"
  local bucket="${value%%/*}"
  local key="${value#*/}"
  if [[ "${uri}" != s3://* || "${key}" == "${value}" || -z "${bucket}" || "${key}" == *".."* ]]; then
    echo "Invalid fake S3 URI: ${uri}" >&2
    exit 2
  fi
  printf '%s/%s/%s\n' "${FAKE_S3_ROOT%/}" "${bucket}" "${key}"
}

if [[ "${1:-}" == "cloudformation" && "${2:-}" == "describe-stacks" ]]; then
  query=""
  shift 2
  while (( $# > 0 )); do
    if [[ "$1" == "--query" ]]; then query="${2:?--query requires a value}"; break; fi
    shift
  done
  case "${query}" in
    *AsaClusterArn*) printf 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/fixture\n' ;;
    *AsaClusterId*) printf 'cluster-fixture\n' ;;
    *AsaMigrationTaskDefinitionArn*) printf 'arn:aws:ecs:ap-northeast-1:123456789012:task-definition/migration:1\n' ;;
    *AsaSecurityGroupId*) printf 'sg-fixture\n' ;;
    *AsaPublicSubnetIds*) printf 'subnet-a,subnet-b\n' ;;
    *AsaStateBucketName*) printf 'fixture-bucket\n' ;;
    *AsaStateTableName*) printf 'fixture-table\n' ;;
    *AsaStateSchemaVersion*) printf '2\n' ;;
    *AsaResourcePrefix*) printf 'fixture/\n' ;;
    *) echo "Unsupported fake stack output query: ${query}" >&2; exit 2 ;;
  esac
  exit
fi

if [[ "${1:-}" == "ecs" ]]; then
  case "${2:-}" in
    list-tasks) exit 0 ;;
    run-task) printf 'arn:aws:ecs:ap-northeast-1:123456789012:task/migration-fixture\n'; exit ;;
    wait) exit 0 ;;
    describe-tasks)
      query=""
      shift 2
      while (( $# > 0 )); do
        if [[ "$1" == "--query" ]]; then query="${2:?--query requires a value}"; break; fi
        shift
      done
      if [[ "${query}" == *lastStatus* ]]; then
        printf 'STOPPED\n'
      elif [[ "${query}" == *exitCode* ]]; then
        printf '0\n'
      else
        printf 'fixture task completed\n'
      fi
      exit
      ;;
  esac
fi

if [[ "${1:-}" == "dynamodb" ]]; then
  case "${2:-}" in
    get-item) printf '0\n'; exit ;;
    scan) exit 0 ;;
    update-item) printf '{}\n'; exit ;;
  esac
fi

if [[ "${1:-}" == "s3api" && "${2:-}" == "head-object" ]]; then
  shift 2
  bucket=""
  key=""
  while (( $# > 0 )); do
    case "$1" in
      --bucket) bucket="${2:?--bucket requires a value}"; shift 2 ;;
      --key) key="${2:?--key requires a value}"; shift 2 ;;
      *) shift ;;
    esac
  done
  [[ -f "${FAKE_S3_ROOT%/}/${bucket}/${key}" ]]
  exit
fi

if [[ "${1:-}" == "s3" && "${2:-}" == "cp" ]]; then
  source_value="${3:?fake aws s3 cp requires a source}"
  destination_value="${4:?fake aws s3 cp requires a destination}"
  if [[ "${source_value}" == s3://* ]]; then source_value="$(s3_path "${source_value}")"; fi
  if [[ "${destination_value}" == s3://* ]]; then destination_value="$(s3_path "${destination_value}")"; fi

  if [[ "${source_value}" == "-" ]]; then
    mkdir -p "$(dirname "${destination_value}")"
    cat >"${destination_value}"
  elif [[ "${destination_value}" == "-" ]]; then
    cat "${source_value}"
  else
    mkdir -p "$(dirname "${destination_value}")"
    cp -- "${source_value}" "${destination_value}"
  fi
  exit
fi

echo "Unsupported fake AWS command: $*" >&2
exit 2
