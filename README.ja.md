# ASA On Demand

ARK: Survival Ascended のプライベート専用サーバーを ECS Fargate Spot で動かし、Discord のスラッシュコマンドで操作する AWS CDK v2 プロジェクト。

元の仕様書は [asa-fargate-spot-discord-spec.md](./asa-fargate-spot-discord-spec.md)、英語版 README は [README.md](./README.md)。

## パッケージマネージャ

npm ではなく pnpm を使う。ワークスペース設定は `pnpm-workspace.yaml` にある。

`minimumReleaseAge: 10080` を設定している。分単位で 1 週間に相当する。

## セットアップ

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run synth
```

## 初回構築手順

以下の例は `--profile my-aws-profile` とリソースプレフィックス `main` を使う。プレフィックスなしのデフォルト環境では `--resource-prefix`、`--resourcePrefix`、`-c resourcePrefix`、`RESOURCE_PREFIX` を省略する。Docker と AWS 認証情報が必要。

1. アカウントとリージョンを bootstrap する(アカウント/リージョンごとに 1 回):

   ```bash
   pnpm exec cdk bootstrap
   ```

2. スタックをデプロイする。デプロイで専用 ECR リポジトリが作られるため、イメージが存在しない状態でも初回デプロイは成功する:

   ```bash
   pnpm exec cdk deploy \
     -c region=ap-northeast-1 \
     -c resourcePrefix=main \
     -c monthlyBudgetJpy=1500 \
     -c monthlyRuntimeHoursLimit=80 \
     -c enableParallelMapTransfer=false \
     -c maxConcurrentMaps=2
   ```

3. サーバーイメージをビルドして push する。ビルド中に SteamCMD が ASA サーバーをダウンロードし、イメージは約 18.5 GB になる:

   ```bash
   ./scripts/push-image.sh \
     --region ap-northeast-1 \
     --profile my-aws-profile \
     --resource-prefix main
   ```

4. シークレットとパラメータを登録する(詳細は[シークレットとパラメータ](#シークレットとパラメータ)):

   ```bash
   RESOURCE_PREFIX=main ./local/put-secrets.sh --profile my-aws-profile
   ```

5. 任意: クラスター共通設定をステートバケット(CDK 出力 `AsaStateBucketName`)の `config/common/` にアップロードし、Map 固有の差分だけを `config/maps/<mapId>/` に置く。コンテナは起動のたびに共通設定、Map overlay の順で適用する:

   ```bash
   aws s3 cp local/GameUserSettings.ini "s3://<AsaStateBucketName>/main/config/common/GameUserSettings.ini"
   aws s3 cp local/Game.ini "s3://<AsaStateBucketName>/main/config/common/Game.ini"
   aws s3 cp local/the-island/Game.ini "s3://<AsaStateBucketName>/main/config/maps/the-island/Game.ini"
   ```

6. Discord Developer Portal で Interactions Endpoint URL に CDK 出力 `DiscordInteractionsEndpointUrl` を設定する。Discord は署名付き ping でエンドポイントを検証するため、手順 4 で public key を登録した後でないと設定に失敗する。

7. ギルドコマンドを登録する(詳細は [Discord](#discord)):

   ```bash
   pnpm run discord:register \
     --profile my-aws-profile \
     --resourcePrefix main
   ```

8. ギルドで `/asa start` を実行する。

順序の制約:

- 手順 3 の前に `/asa start` すると、ECS タスクはイメージの pull エラーで停止する。
- 手順 6 と 7 は、どちらも Discord の認証情報を SSM と Secrets Manager から読むため、手順 4 の前に実行すると失敗する。
- destroy → deploy をやり直すと API Gateway の URL が変わるため、手順 6 を再実行する。teardown 時にシークレットとパラメータも削除した場合は手順 4 も再実行する。Discord コマンド自体は登録されたまま残るので再登録は不要。

## リソースプレフィックス

`-c resourcePrefix` を設定すると、独立したサーバー環境ごとに CloudFormation スタックと S3 オブジェクト名前空間を分離できる。Map 名や先頭・末尾の `/` は含めず、`main` のような単純な環境識別子を使う。Map ごとの分離は `maps/<mapId>/` 以下で行われる。`resourcePrefix=main` の場合、ステートファイルは以下に保存される:

- `main/config/common/`
- `main/config/maps/<mapId>/`
- `main/maps/<mapId>/saves/`
- `main/maps/<mapId>/backups/`
- `main/maps/<mapId>/runtime/`

スタック名は `AsaFargateStack-main`、自動停止スケジュール名は `asa-main-<mapId>-auto-stop` になり、ロググループは `/asa/main/...` 配下に移る。

## 並列マップ転送(PoC)

1 スタックを 1 ASA クラスターとして扱い、Map ごとに独立した Fargate タスク、S3 セーブ/ランタイム、public IP、自動停止スケジュール、DynamoDB 行を持つ。Cross-ARK データだけを暗号化 EFS の `/asa/cluster` で共有し、全 Map が同じ安定した `asaClusterId` と `-ClusterDirOverride` を使う。

rollout flag の既定値は `enableParallelMapTransfer=false` で、新 schema を使いつつ同時実行数を 1 に制限する。migration、rollback、EFS restore、ゲーム内の受入試験は [並列転送 runbook](./docs/parallel-map-transfer-runbook.ja.md) を参照する。synth/unit test の成功だけで本番 flag を有効にしてはいけない。ASA + Proton + EFS の組み合わせは 2 Map の実ゲーム PoC が必要。

## シークレットとパラメータ

[scripts/put-secrets.example.sh](./scripts/put-secrets.example.sh) をテンプレートとして使う。実際のシークレットとローカルのサーバー設定は、gitignore 済みの `local/` ディレクトリに置く:

```bash
mkdir -p local
cp scripts/put-secrets.example.sh local/put-secrets.sh
```

プレフィックス付き環境では、SSM パラメータと Secrets Manager のシークレットを対応するリソースプレフィックス配下に登録する:

```bash
RESOURCE_PREFIX=main ./local/put-secrets.sh --profile my-aws-profile
```

`resourcePrefix` を設定すると、SSM パラメータと Secrets Manager のシークレットは `/asa/<resourcePrefix>` から読み込まれる。

必須の Secrets Manager 値:

- `/asa/<resourcePrefix>/discord/bot-token`
- `/asa/<resourcePrefix>/discord/notification-webhook-url`
- `/asa/<resourcePrefix>/server/password`
- `/asa/<resourcePrefix>/server/admin-password`

必須の SSM パラメータ:

- `/asa/<resourcePrefix>/discord/application-id`
- `/asa/<resourcePrefix>/discord/public-key`
- `/asa/<resourcePrefix>/discord/guild-id`
- `/asa/<resourcePrefix>/discord/allowed-role-ids`
- `/asa/<resourcePrefix>/discord/allowed-user-ids`
- `/asa/<resourcePrefix>/server/session-name`
- `/asa/<resourcePrefix>/server/default-map`
- `/asa/<resourcePrefix>/server/max-players`

任意の SSM パラメータ:

- `/asa/<resourcePrefix>/server/enabled-maps` — `TheIsland_WP,ScorchedEarth_WP` のようなカンマ区切りのマップ値。未設定なら共有許可リストの全マップを有効にする。SSM の String パラメータには空文字を設定できないため、制限を解除する場合はこのパラメータを削除する。変更または削除した後は `pnpm run discord:register` を再実行する。
- `/asa/<resourcePrefix>/server/event-mod-id` — 起動する ASA イベント mod の CurseForge project ID。`/asa start` のたびに最新値を読み、`-mods=<ID>` として適用する。未設定、削除、または `None` ならイベント mod を指定しない。変更は稼働中のタスクには反映されないため、サーバーを停止してから再起動する。

たとえば Summer Bash 2026 の公式案内にある Mod ID `927091` をプレフィックス付き環境へ設定する:

```bash
aws ssm put-parameter \
  --profile my-aws-profile \
  --name /asa/main/server/event-mod-id \
  --type String \
  --value 927091 \
  --overwrite
```

イベントごとに有効化方法や Mod ID が変わる可能性があるため、設定時は Studio Wildcard の最新案内を確認する。

プレフィックスなしのデフォルト環境では `resourcePrefix` を省略し、`/asa/discord/bot-token`、`/asa/server/default-map` のようになる。`resourcePrefix=main` の場合は `/asa/main/discord/bot-token`、`/asa/main/server/default-map` のようになる。

## Discord

Discord の Interactions Endpoint URL に CDK 出力 `DiscordInteractionsEndpointUrl` を設定する。

ギルドコマンドの登録:

```bash
pnpm run discord:register \
  --profile my-aws-profile \
  --resourcePrefix main
```

このスクリプトは bot トークンを Secrets Manager から、アプリケーション ID・ギルド ID と任意のマップ制限を SSM の `server/enabled-maps` から読み込む。従来どおり `DISCORD_BOT_TOKEN`、`DISCORD_APPLICATION_ID`、`DISCORD_GUILD_ID`、`ASA_ENABLED_MAPS` の環境変数で上書きもできる。

## よく使うコマンド

```bash
pnpm run build
pnpm run test
pnpm run synth
pnpm run smoke
ASA_TEST_IMAGE=ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/REPOSITORY:BUILD_ID pnpm run test:container
pnpm run image:push --profile my-aws-profile
```

## 現在の実装メモ

- ECS タスクは `RunTask` で起動する。ECS Service は作らない。
- VPC はパブリックサブネットのみで、NAT Gateway はない。
- キャパシティプロバイダ戦略のデフォルトは Fargate Spot。`-c enableOnDemandFallback=true` を指定しない限りオンデマンドへのフォールバックは無効。
- タスクサイズのデフォルトは 4 vCPU・24 GiB メモリ。
- Discord の budget 出力は、保守的な見積もり(`hourlyCostJpy`、デフォルト 52 円/時)と Fargate Spot の変動見積もり(`spotHourlyCostJpy`、デフォルト 17 円/時)の両方を表示する。
- `/asa start` の `idle_minutes` は 1〜1440 分(既定 30 分)。Map セッションごとに独立した timeout と Map 専用 heartbeat を管理し、そのセッションの時刻が異なる fresh な heartbeat が設定時間連続して 0 人を示した場合だけ停止する。heartbeat の欠落・鮮度切れ・別 runId だけでは idle stop しない。月間 task-hour 上限は確定済み実行時間と全アクティブ Map の実経過時間の合計で判定し、固定のセッション時間は予約しない。
- ASA と UMU-Proton は `scripts/push-image.sh` の Docker イメージビルド時にインストールされる。CDK の synth / deploy は Docker を起動しない。
- ASA のアップデートを取り込むには、まず `./scripts/push-image.sh --build-id 2026-07-05` を実行し、次に同じタグで `pnpm exec cdk deploy -c asaBuildId=2026-07-05` をデプロイする。タグが存在しない・一致しない場合、ECS タスクはイメージの pull エラーで停止する。
- `-c asaUpdateOnStart=true` で、タスク起動のたびに SteamCMD で更新する緊急用モードを有効にできる。デフォルトは無効。
- マップの選択肢は Lambda が検証し、共有の許可リストから登録される。任意の `server/enabled-maps` パラメータで環境ごとのサブセットに制限できる。共有リストまたはこのパラメータを変更したら `pnpm run discord:register` を再実行する。
- ASA イベント mod は任意の `server/event-mod-id` パラメータで選ぶ。Lambda は起動ごとに値を読み、数値の project ID だけを ECS タスクへ渡し、コンテナが `-mods=<ID>` を起動引数へ追加する。選択中の ID は start/status/info と READY 通知に表示される。
- 並列転送は gate 付き PoC。Map セーブは独立した S3 archive に置き、Cross-ARK データだけを retain/encrypted EFS で共有する。クロススタック転送はサポートしない。
- Discord コマンドは即座に deferred 応答を返し、AWS 操作を非同期に実行して、結果を follow-up 応答で返す。準備完了やライフサイクルの通知は設定した Discord webhook に送られる。
- ステートバケットはバージョニング有効で、非カレントのオブジェクトバージョンはライフサイクルルールにより 7 日で削除される。
- スタックごとに専用の ECR リポジトリを持ち、最新 2 イメージのみ保持する。スタックの destroy 時にはイメージごと削除される。
