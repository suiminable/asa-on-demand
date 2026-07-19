# Parallel Map Transfer PoC Runbook

[日本語版](./parallel-map-transfer-runbook.ja.md)

This runbook is deliberately gated. The deployment proves the AWS/control-plane shape, but only an in-game PoC can prove that ASA running through Proton is compatible with EFS/NFS file semantics.

## 0. Rehearse the storage scripts locally

After building the candidate ASA image, run the storage fixture test against that exact image:

```bash
ASA_TEST_IMAGE=ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/REPOSITORY:BUILD_ID \
  pnpm run test:container
```

The test runs the current repository scripts in the container as the dedicated migration task's root user. It uses only a temporary fake S3/EFS tree and verifies:

- legacy archive split into two Map archives plus an EFS cluster directory;
- non-overwrite behavior and an explicitly approved retry with preservation of the previous EFS directory;
- runtime UID/GID ownership, safe extraction, common/Map config order, and preservation of transfer settings;
- independent Map backups without `Saved/clusters`;
- legacy rollback export and recovered-cluster promotion;
- the ECS migration wrapper's task inputs and schema-v2 initialization calls.

This is a deterministic script rehearsal, not evidence that ASA/Proton accepts EFS file semantics. The in-game gate in section 6 remains mandatory.

## 1. Deploy with concurrency disabled

Build and push the image containing `migrate-storage.sh` before deploying the task definitions that reference it.

```bash
./scripts/push-image.sh --profile PROFILE --region ap-northeast-1 --resource-prefix PREFIX --build-id BUILD_ID

pnpm exec cdk deploy \
  --profile PROFILE \
  -c resourcePrefix=PREFIX \
  -c asaBuildId=BUILD_ID \
  -c asaClusterId=EXISTING_CLUSTER_ID \
  -c enableParallelMapTransfer=false \
  -c maxConcurrentMaps=2
```

With the flag disabled, the v2 Map/S3/state model is active but `MAX_CONCURRENT_MAPS=1`. Do not change the existing `asaClusterId`.

Before migration, verify the CDK outputs include `AsaClusterFileSystemId`, `AsaClusterAccessPointId`, `AsaMigrationTaskDefinitionArn`, `AsaClusterId`, and state schema version `2`. The wrapper refuses a `--cluster-id` that differs from the deployed `AsaClusterId` output.

## 2. Back up and inspect the source

1. Stop every ASA task and confirm `CLUSTER.activeCount` is absent or zero.
2. Run a final legacy backup.
3. Record the exact `asaClusterId`.
4. Create a DynamoDB on-demand backup and preserve the current S3 object version for `<resourcePrefix>/saves/current.tar.zst`.
5. List the archive and confirm it contains `Saved/clusters/clusters/<asaClusterId>/`.

Example archive inspection:

```bash
aws s3 cp s3://BUCKET/PREFIX/saves/current.tar.zst /tmp/asa-legacy-current.tar.zst
tar --zstd -tf /tmp/asa-legacy-current.tar.zst | less
```

If the real archive does not use `Saved/clusters/clusters/<asaClusterId>`, stop. The one-shot task intentionally refuses to guess a different split rule. ASA creates the inner `clusters/<clusterId>` namespace below `-ClusterDirOverride`.

## 3. Run the one-shot migration

The wrapper refuses to run while the dedicated ECS cluster has RUNNING/PENDING tasks or `CLUSTER.activeCount` is non-zero. Destinations are non-overwriting by default.

```bash
./scripts/run-storage-migration.sh \
  --profile PROFILE \
  --region ap-northeast-1 \
  --stack-name STACK_NAME \
  --mode migrate-parallel \
  --cluster-id EXISTING_CLUSTER_ID \
  --maps the-island,scorched-earth
```

The migration task:

- validates archive paths before extraction;
- rejects archive links/devices and stages EFS copies before promotion;
- copies `Saved/clusters/clusters/<clusterId>` to EFS `/cluster-data/clusters/<clusterId>`;
- removes `Saved/clusters` from the Map archive;
- removes generated `GameUserSettings.ini`/`Game.ini` from Map archives so injected passwords are not copied into the new save keys;
- creates `maps/<mapId>/saves/current.tar.zst` for each requested Map;
- moves legacy config objects into `config/common/` when present;
- writes `migration/parallel-storage-v2.json` only after the copies complete;
- leaves the legacy archive untouched;
- verifies the marker and every requested Map archive from the wrapper;
- initializes the DynamoDB `CLUSTER` schema.

`--allow-overwrite` is a recovery switch, not a normal retry option. Inspect partial S3/EFS results and take another backup before using it. An approved retry preserves the former live directory as `.pre-migration-*`, promotes a fully copied UID/GID 10001 staging directory, and leaves the preserved copy in place for manual cleanup after acceptance.

The dedicated task uses the same ephemeral-storage size as the game task because the image, compressed archive, extracted tree, and repacked archive coexist temporarily. The wrapper waits up to two hours by default; use `--wait-timeout-seconds` only when the measured archive size requires a different bound.

## 4. Rehearse rollback before enabling parallelism

While all Map tasks are stopped, export one selected Map plus the current EFS cluster data back into the legacy archive shape. Use a new rollback key for rehearsal.

```bash
./scripts/run-storage-migration.sh \
  --profile PROFILE \
  --region ap-northeast-1 \
  --stack-name STACK_NAME \
  --mode export-legacy \
  --cluster-id EXISTING_CLUSTER_ID \
  --rollback-map the-island \
  --rollback-key PREFIX/rollback-rehearsal/current.tar.zst
```

Download the result and verify that both the Map save and `Saved/clusters/clusters/<clusterId>` exist. A production rollback additionally requires redeploying the old task/Lambda code and recreating its stopped `SERVER` row from the DynamoDB backup; do not enable parallelism until that procedure has been rehearsed.

## 5. EFS backup and restore rehearsal

The stack creates an encrypted retained Regional EFS, a retained backup vault, hourly recovery points retained for 7 days, and daily recovery points retained for `clusterBackupRetentionDays` (35 days by default).

Before an ASA build update or production migration, start an on-demand AWS Backup job for the `AsaClusterFileSystemId`. Record a recovery point made while all Maps are stopped as `known-good`.

For an item-level restore, restore the case-sensitive path `/cluster-data/clusters/<clusterId>` to the existing file system. AWS Backup places restored content under a new `aws-backup-restore_<timestamp>` recovery directory instead of overwriting the source. After the restore job succeeds and while all Maps remain stopped, promote it with:

```bash
./scripts/run-storage-migration.sh \
  --profile PROFILE \
  --region ap-northeast-1 \
  --stack-name STACK_NAME \
  --mode restore-cluster \
  --cluster-id EXISTING_CLUSTER_ID \
  --restored-cluster-path aws-backup-restore_TIMESTAMP/cluster-data/clusters/EXISTING_CLUSTER_ID \
  --allow-overwrite
```

Promotion moves the previous live cluster directory to a timestamped `.pre-restore-*` directory before copying the recovered data. Remove that preserved directory only after the restored Cross-ARK data passes acceptance testing.

Use `aws backup get-recovery-point-restore-metadata` before a CLI restore; required restore metadata can vary. The AWS Backup console is acceptable for the rehearsal and makes the existing-file-system/item-path choices explicit.

## 6. Parallel game acceptance gate

Enable the feature only after migration and rollback rehearsal:

```bash
pnpm exec cdk deploy \
  --profile PROFILE \
  -c resourcePrefix=PREFIX \
  -c asaBuildId=BUILD_ID \
  -c asaClusterId=EXISTING_CLUSTER_ID \
  -c enableParallelMapTransfer=true \
  -c maxConcurrentMaps=2
```

Then verify all of the following with disposable test data:

1. Start The Island and Scorched Earth and confirm two READY markers, distinct public IPs, and unique session names.
2. Confirm the destination session appears in the terminal UI.
3. Transfer a test survivor A → B → A without stopping either Map.
4. Transfer one item and one creature in both directions.
5. Confirm EFS file creation/rename/delete behavior and the absence of `Saved/clusters` in both Map archives.
6. Back up and stop only one Map; confirm the other Map's world, heartbeat, schedule, and state do not change.
7. Exercise a stale schedule payload and duplicate/reordered ECS events.
8. Repeat during a controlled Spot interruption on one side.
9. Stop both Maps, restart both, and repeat a transfer.

If EFS probes pass but ASA transfer corrupts, duplicates, or loses data, discard the branch or move the design to a single-host shared local filesystem. Do not add a local cluster-directory fallback.
