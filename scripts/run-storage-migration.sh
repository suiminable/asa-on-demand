#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/run-storage-migration.sh --stack-name STACK --mode migrate-parallel \
    --cluster-id CLUSTER_ID --maps the-island,scorched-earth [--profile PROFILE] [--region REGION]

  scripts/run-storage-migration.sh --stack-name STACK --mode export-legacy \
    --cluster-id CLUSTER_ID --rollback-map the-island [--rollback-key KEY] [--profile PROFILE] [--region REGION]

  scripts/run-storage-migration.sh --stack-name STACK --mode restore-cluster \
    --cluster-id CLUSTER_ID --restored-cluster-path aws-backup-restore_TIMESTAMP/cluster-data/CLUSTER_ID

The task refuses to overwrite any destination by default. Use --allow-overwrite only
after taking the S3/DynamoDB/EFS backups described in the runbook.
The task wait timeout defaults to 7200 seconds and can be changed with --wait-timeout-seconds.
EOF
}

stack_name=""
mode=""
cluster_id=""
map_ids=""
rollback_map=""
rollback_key=""
restored_cluster_path=""
profile=""
region=""
allow_overwrite="false"
wait_timeout_seconds="${MIGRATION_WAIT_TIMEOUT_SECONDS:-7200}"

while (( $# > 0 )); do
  case "$1" in
    --stack-name) stack_name="${2:?--stack-name requires a value}"; shift 2 ;;
    --mode) mode="${2:?--mode requires a value}"; shift 2 ;;
    --cluster-id) cluster_id="${2:?--cluster-id requires a value}"; shift 2 ;;
    --maps) map_ids="${2:?--maps requires a value}"; shift 2 ;;
    --rollback-map) rollback_map="${2:?--rollback-map requires a value}"; shift 2 ;;
    --rollback-key) rollback_key="${2:?--rollback-key requires a value}"; shift 2 ;;
    --restored-cluster-path) restored_cluster_path="${2:?--restored-cluster-path requires a value}"; shift 2 ;;
    --profile) profile="${2:?--profile requires a value}"; shift 2 ;;
    --region) region="${2:?--region requires a value}"; shift 2 ;;
    --allow-overwrite) allow_overwrite="true"; shift ;;
    --wait-timeout-seconds) wait_timeout_seconds="${2:?--wait-timeout-seconds requires a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "${stack_name}" || -z "${cluster_id}" ]]; then usage >&2; exit 2; fi
if [[ "${mode}" == "migrate-parallel" && -z "${map_ids}" ]]; then usage >&2; exit 2; fi
if [[ "${mode}" == "export-legacy" && -z "${rollback_map}" ]]; then usage >&2; exit 2; fi
if [[ "${mode}" == "restore-cluster" && -z "${restored_cluster_path}" ]]; then usage >&2; exit 2; fi
if [[ "${mode}" != "migrate-parallel" && "${mode}" != "export-legacy" && "${mode}" != "restore-cluster" ]]; then usage >&2; exit 2; fi
if [[ ! "${cluster_id}" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then echo "Invalid cluster ID." >&2; exit 2; fi
if [[ "${mode}" == "migrate-parallel" ]]; then
  if [[ ! "${map_ids}" =~ ^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$ ]]; then
    echo "--maps must be a comma-separated list of mapId values without whitespace or empty entries." >&2
    exit 2
  fi
  IFS=',' read -r -a requested_map_ids <<<"${map_ids}"
  declare -A seen_map_ids=()
  for map_id in "${requested_map_ids[@]}"; do
    if [[ ! "${map_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then echo "Invalid mapId: ${map_id}" >&2; exit 2; fi
    if [[ -n "${seen_map_ids[${map_id}]:-}" ]]; then echo "Duplicate mapId: ${map_id}" >&2; exit 2; fi
    seen_map_ids["${map_id}"]=1
  done
fi
if [[ ! "${wait_timeout_seconds}" =~ ^[0-9]+$ ]] || (( wait_timeout_seconds < 60 || wait_timeout_seconds > 86400 )); then
  echo "Migration wait timeout must be an integer from 60 through 86400 seconds." >&2
  exit 2
fi

aws_args=()
if [[ -n "${profile}" ]]; then aws_args+=(--profile "${profile}"); fi
if [[ -n "${region}" ]]; then aws_args+=(--region "${region}"); fi

stack_output() {
  local key="$1"
  aws "${aws_args[@]}" cloudformation describe-stacks \
    --stack-name "${stack_name}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text
}

cluster_arn="$(stack_output AsaClusterArn)"
deployed_cluster_id="$(stack_output AsaClusterId)"
task_definition="$(stack_output AsaMigrationTaskDefinitionArn)"
security_group="$(stack_output AsaSecurityGroupId)"
subnet_ids="$(stack_output AsaPublicSubnetIds)"
bucket="$(stack_output AsaStateBucketName)"
state_table="$(stack_output AsaStateTableName)"
state_schema_version="$(stack_output AsaStateSchemaVersion)"
resource_prefix="$(stack_output AsaResourcePrefix)"
if [[ "${resource_prefix}" == "/" ]]; then resource_prefix=""; fi
legacy_key="${resource_prefix}saves/current.tar.zst"
if [[ "${cluster_id}" != "${deployed_cluster_id}" ]]; then
  echo "Refusing migration: --cluster-id ${cluster_id} does not match the stack AsaClusterId output ${deployed_cluster_id}." >&2
  exit 1
fi
if [[ "${state_schema_version}" != "2" ]]; then
  echo "Refusing migration: stack state schema output is ${state_schema_version}, expected 2." >&2
  exit 1
fi

running_tasks="$(aws "${aws_args[@]}" ecs list-tasks --cluster "${cluster_arn}" --desired-status RUNNING --query 'taskArns' --output text)"
pending_tasks="$(aws "${aws_args[@]}" ecs list-tasks --cluster "${cluster_arn}" --desired-status PENDING --query 'taskArns' --output text)"
if [[ -n "${running_tasks}${pending_tasks}" ]]; then
  echo "Refusing storage migration while ECS tasks are RUNNING or PENDING in the ASA cluster." >&2
  exit 1
fi
active_count="$(aws "${aws_args[@]}" dynamodb get-item --table-name "${state_table}" --key '{"pk":{"S":"CLUSTER"}}' \
  --query 'Item.activeCount.N' --output text)"
if [[ "${active_count}" != "None" && "${active_count}" != "0" ]]; then
  echo "Refusing storage migration while CLUSTER.activeCount=${active_count}." >&2
  exit 1
fi

environment_json="$(jq -cn \
  --arg mode "${mode}" \
  --arg bucket "${bucket}" \
  --arg prefix "${resource_prefix}" \
  --arg clusterId "${cluster_id}" \
  --arg legacyKey "${legacy_key}" \
  --arg mapIds "${map_ids}" \
  --arg rollbackMap "${rollback_map}" \
  --arg rollbackKey "${rollback_key}" \
  --arg restoredPath "${restored_cluster_path}" \
  --arg overwrite "${allow_overwrite}" \
  '[
    {name:"ASA_OPERATION_MODE",value:$mode},
    {name:"S3_BUCKET",value:$bucket},
    {name:"S3_RESOURCE_PREFIX",value:$prefix},
    {name:"ASA_CLUSTER_ID",value:$clusterId},
    {name:"LEGACY_S3_SAVE_KEY",value:$legacyKey},
    {name:"MIGRATION_MAP_IDS",value:$mapIds},
    {name:"ROLLBACK_MAP_ID",value:$rollbackMap},
    {name:"ROLLBACK_S3_SAVE_KEY",value:$rollbackKey},
    {name:"RESTORED_CLUSTER_PATH",value:$restoredPath},
    {name:"MIGRATION_ALLOW_OVERWRITE",value:$overwrite}
  ]')"

network_json="$(jq -cn --arg subnets "${subnet_ids}" --arg sg "${security_group}" \
  '{awsvpcConfiguration:{assignPublicIp:"ENABLED",subnets:($subnets|split(",")),securityGroups:[$sg]}}')"
overrides_json="$(jq -cn --argjson environment "${environment_json}" \
  '{containerOverrides:[{name:"AsaServerContainer",environment:$environment}]}')"

task_arn="$(aws "${aws_args[@]}" ecs run-task \
  --cluster "${cluster_arn}" \
  --task-definition "${task_definition}" \
  --capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
  --network-configuration "${network_json}" \
  --overrides "${overrides_json}" \
  --group "asa-storage-migration" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [[ -z "${task_arn}" || "${task_arn}" == "None" ]]; then
  echo "ECS did not return a migration task ARN." >&2
  exit 1
fi

echo "Started migration task: ${task_arn}"
wait_deadline=$(( SECONDS + wait_timeout_seconds ))
while true; do
  last_status="$(aws "${aws_args[@]}" ecs describe-tasks --cluster "${cluster_arn}" --tasks "${task_arn}" \
    --query 'tasks[0].lastStatus' --output text)"
  if [[ "${last_status}" == "STOPPED" ]]; then break; fi
  if (( SECONDS >= wait_deadline )); then
    echo "Timed out after ${wait_timeout_seconds}s waiting for migration task ${task_arn}; the task was not stopped." >&2
    exit 1
  fi
  sleep 15
done
exit_code="$(aws "${aws_args[@]}" ecs describe-tasks --cluster "${cluster_arn}" --tasks "${task_arn}" \
  --query 'tasks[0].containers[?name==`AsaServerContainer`].exitCode | [0]' --output text)"
stopped_reason="$(aws "${aws_args[@]}" ecs describe-tasks --cluster "${cluster_arn}" --tasks "${task_arn}" \
  --query 'tasks[0].stoppedReason' --output text)"
echo "Migration task stopped: exit=${exit_code}; reason=${stopped_reason}"
if [[ "${exit_code}" != "0" ]]; then exit 1; fi

if [[ "${mode}" == "migrate-parallel" ]]; then
  marker_key="${resource_prefix}migration/parallel-storage-v2.json"
  marker_json="$(aws "${aws_args[@]}" s3 cp "s3://${bucket}/${marker_key}" -)"
  jq -e --arg clusterId "${cluster_id}" --arg mapIds "${map_ids}" \
    '.schemaVersion == 2 and .clusterId == $clusterId and .mapIds == ($mapIds | split(","))' \
    <<<"${marker_json}" >/dev/null || {
      echo "Migration marker did not match the requested cluster and Map set: s3://${bucket}/${marker_key}" >&2
      exit 1
    }
  for map_id in "${requested_map_ids[@]}"; do
    aws "${aws_args[@]}" s3api head-object \
      --bucket "${bucket}" \
      --key "${resource_prefix}maps/${map_id}/saves/current.tar.zst" >/dev/null
  done
  echo "Verified the migration marker and ${#requested_map_ids[@]} Map archive object(s)."

  budget_pks="$(aws "${aws_args[@]}" dynamodb scan \
    --table-name "${state_table}" \
    --filter-expression 'begins_with(pk, :prefix)' \
    --expression-attribute-values '{":prefix":{"S":"BUDGET#"}}' \
    --projection-expression pk \
    --query 'Items[].pk.S' \
    --output text)"
  for budget_pk in ${budget_pks}; do
    aws "${aws_args[@]}" dynamodb update-item \
      --table-name "${state_table}" \
      --key "$(jq -cn --arg pk "${budget_pk}" '{pk:{S:$pk}}')" \
      --update-expression 'SET committedRuntimeSeconds = if_not_exists(committedRuntimeSeconds, runtimeSeconds), reservedRuntimeSeconds = if_not_exists(reservedRuntimeSeconds, :zero)' \
      --expression-attribute-values '{":zero":{"N":"0"}}' >/dev/null
  done
  aws "${aws_args[@]}" dynamodb update-item \
    --table-name "${state_table}" \
    --key '{"pk":{"S":"CLUSTER"}}' \
    --update-expression 'SET activeCount = if_not_exists(activeCount, :zero), maxConcurrentMaps = if_not_exists(maxConcurrentMaps, :one), schemaVersion = :schema, updatedAt = :now' \
    --expression-attribute-values "$(jq -cn --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{":zero":{N:"0"},":one":{N:"1"},":schema":{N:"2"},":now":{S:$now}}')" >/dev/null
  echo "DynamoDB budget counters and CLUSTER schema were initialized for schema version 2."
fi
