# 並列 Map 転送 PoC Runbook

[English](./parallel-map-transfer-runbook.md)

この runbook は意図的に段階的な gate を設けている。デプロイによって AWS/control plane の構成は検証できるが、Proton 経由で動作する ASA が EFS/NFS のファイルセマンティクスと両立するかは、ゲーム内 PoC でしか確認できない。

## 0. ストレージスクリプトをローカルで rehearsal する

候補となる ASA イメージをビルドした後、その正確なイメージを指定してストレージ fixture test を実行する。

```bash
ASA_TEST_IMAGE=ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/REPOSITORY:BUILD_ID \
  pnpm run test:container
```

このテストは、専用 migration task の root user と同じ条件で、現在のリポジトリにあるスクリプトをコンテナ内から実行する。一時的な偽 S3/EFS ツリーだけを使用し、次を検証する。

- legacy archive を 2 つの Map archive と EFS cluster directory に分割できること
- デフォルトでは上書きせず、明示的に許可した retry では以前の EFS directory を退避すること
- runtime UID/GID ownership、安全な展開、common/Map config の適用順、transfer 設定の保持
- `Saved/clusters` を含まない Map ごとの独立した backup
- legacy rollback export と復元済み cluster の昇格
- ECS migration wrapper の task input と schema v2 初期化呼び出し

これは決定的に再現可能なスクリプト rehearsal であり、ASA/Proton が EFS のファイルセマンティクスを受け入れる証拠にはならない。セクション 6 のゲーム内 gate は必須である。

## 1. 並列起動を無効にしてデプロイする

`migrate-storage.sh` を含むイメージを build/push してから、そのイメージを参照する task definition をデプロイする。

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

flag が無効でも v2 の Map/S3/state model は有効になるが、`MAX_CONCURRENT_MAPS=1` に制限される。既存の `asaClusterId` は変更しないこと。

migration 前に、CDK output に `AsaClusterFileSystemId`、`AsaClusterAccessPointId`、`AsaMigrationTaskDefinitionArn`、`AsaClusterId`、state schema version `2` が含まれることを確認する。wrapper は、`--cluster-id` がデプロイ済みの `AsaClusterId` output と一致しない場合に実行を拒否する。

## 2. 移行元を backup・確認する

1. すべての ASA task を停止し、`CLUSTER.activeCount` が存在しないか `0` であることを確認する。
2. 最後の legacy backup を実行する。
3. 正確な `asaClusterId` を記録する。
4. DynamoDB の on-demand backup を作成し、`<resourcePrefix>/saves/current.tar.zst` の現在の S3 object version を保全する。
5. archive の一覧を取得し、`Saved/clusters/clusters/<asaClusterId>/` が含まれることを確認する。

archive 確認例:

```bash
aws s3 cp s3://BUCKET/PREFIX/saves/current.tar.zst /tmp/asa-legacy-current.tar.zst
tar --zstd -tf /tmp/asa-legacy-current.tar.zst | less
```

実データの archive が `Saved/clusters/clusters/<asaClusterId>` を使っていない場合は作業を中止する。one-shot task は、異なる分割規則を推測せず、意図的に処理を拒否する。ASA は `-ClusterDirOverride` の下に内部 namespace `clusters/<clusterId>` を作成する。

## 3. One-shot migration を実行する

専用 ECS cluster に RUNNING/PENDING task が存在する場合、または `CLUSTER.activeCount` が `0` でない場合、wrapper は実行を拒否する。デフォルトでは移行先を上書きしない。

```bash
./scripts/run-storage-migration.sh \
  --profile PROFILE \
  --region ap-northeast-1 \
  --stack-name STACK_NAME \
  --mode migrate-parallel \
  --cluster-id EXISTING_CLUSTER_ID \
  --maps the-island,scorched-earth
```

migration task は次を行う。

- 展開前に archive path を検証する
- archive 内の link/device を拒否し、EFS copy を staging してから昇格する
- `Saved/clusters/clusters/<clusterId>` を EFS の `/cluster-data/clusters/<clusterId>` へコピーする
- Map archive から `Saved/clusters` を削除する
- 注入済み password が新しい save key へコピーされないよう、生成済み `GameUserSettings.ini`/`Game.ini` を Map archive から削除する
- 指定した各 Map に `maps/<mapId>/saves/current.tar.zst` を作成する
- legacy config object が存在する場合は `config/common/` へ移す
- すべてのコピー完了後にだけ `migration/parallel-storage-v2.json` を書き込む
- legacy archive は変更しない
- wrapper から marker と指定した全 Map archive を検証する
- DynamoDB の `CLUSTER` schema を初期化する

`--allow-overwrite` は通常の retry option ではなく、復旧用の switch である。使用前に S3/EFS の部分的な結果を調査し、もう一度 backup を取得すること。上書きを許可した retry では、以前の live directory を `.pre-migration-*` として退避し、UID/GID 10001 で完全にコピーした staging directory を昇格する。退避したコピーは受入試験完了後に手動で削除するまで残る。

専用 task は、image、圧縮 archive、展開済み tree、再圧縮 archive が一時的に共存するため、game task と同じ ephemeral storage size を使用する。wrapper のデフォルト待機時間は 2 時間である。実測した archive size に応じて変更が必要な場合にだけ `--wait-timeout-seconds` を使う。

## 4. 並列化を有効にする前に rollback を rehearsal する

すべての Map task を停止した状態で、選択した 1 Map と現在の EFS cluster data を legacy archive 形式へ export する。rehearsal では新しい rollback key を使用する。

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

結果を download し、Map save と `Saved/clusters/clusters/<clusterId>` の両方が存在することを確認する。本番 rollback では、さらに旧 task/Lambda code の再デプロイと、DynamoDB backup から停止状態の `SERVER` row を再作成する必要がある。この手順を rehearsal するまで並列化を有効にしないこと。

## 5. EFS backup/restore を rehearsal する

stack は、暗号化・保持設定済みの Regional EFS と backup vault、7 日間保持する 1 時間ごとの recovery point、`clusterBackupRetentionDays` の期間保持する 1 日ごとの recovery point を作成する。`clusterBackupRetentionDays` のデフォルトは 35 日である。

ASA build 更新または本番 migration の前に、`AsaClusterFileSystemId` に対する AWS Backup の on-demand job を開始する。すべての Map が停止している間に作成された recovery point を `known-good` として記録する。

item-level restore では、大文字・小文字を区別して `/cluster-data/clusters/<clusterId>` を既存 file system へ復元する。AWS Backup は移行元を直接上書きせず、復元内容を新しい `aws-backup-restore_<timestamp>` recovery directory 以下に配置する。restore job が成功した後、すべての Map を停止したまま次を実行して昇格する。

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

昇格処理は、以前の live cluster directory を timestamp 付きの `.pre-restore-*` directory へ移動してから、復元済みデータをコピーする。復元した Cross-ARK data が受入試験を通過するまで、退避 directory を削除しないこと。

CLI で復元する場合は、事前に `aws backup get-recovery-point-restore-metadata` を使用する。必要な restore metadata は変わる場合がある。rehearsal では AWS Backup console を使ってもよく、既存 file system と item path の指定を明示的に確認できる。

## 6. 並列ゲーム受入 gate

migration と rollback rehearsal が完了した後にだけ機能を有効にする。

```bash
pnpm exec cdk deploy \
  --profile PROFILE \
  -c resourcePrefix=PREFIX \
  -c asaBuildId=BUILD_ID \
  -c asaClusterId=EXISTING_CLUSTER_ID \
  -c enableParallelMapTransfer=true \
  -c maxConcurrentMaps=2
```

使い捨ての test data を使い、次をすべて確認する。

1. The Island と Scorched Earth を起動し、2 つの READY marker、異なる public IP、一意な session name を確認する。
2. terminal UI に移動先 session が表示されることを確認する。
3. 両方の Map を停止せず、test survivor を A → B → A と転送する。
4. item 1 個と creature 1 体を双方向に転送する。
5. EFS 上の file create/rename/delete と、両方の Map archive に `Saved/clusters` が存在しないことを確認する。
6. 一方の Map だけを backup・停止し、他方の Map の world、heartbeat、schedule、state が変化しないことを確認する。
7. stale schedule payload と duplicate/reordered ECS event を発生させる。
8. 一方で制御した Spot interruption を発生させ、同じ確認を繰り返す。
9. 両方の Map を停止・再起動し、もう一度転送する。

EFS probe が成功しても ASA の転送でデータが破損・複製・消失する場合は、この branch を破棄するか、単一 host の共有 local filesystem を使う設計へ移行する。local cluster directory への fallback は追加しないこと。
