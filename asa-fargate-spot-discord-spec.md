# ARK: Survival Ascended Private Server on ECS Fargate Spot

## 1. 目的

ARK: Survival Ascended の少人数向け専用サーバーを、EC2を使わず、AWS CDKで再現可能に構築する。

主な要件:

- IaC は AWS CDK v2 を使う。
- EC2 / Lightsail / VPS / 手管理サーバーは使わない。
- ECS Fargate Spot 上で ASA dedicated server を起動する。
- Linux コンテナ上で Proton / UMU 経由で Windows 向け ASA dedicated server を動かす。
- セーブデータと設定は S3 に永続化する。
- 起動・停止・状態確認は Discord の Slash Commands から行う。
- サーバー起動情報は Discord チャンネルに通知する。
- 24時間常時稼働ではなく、遊ぶときだけ起動する。
- 月額目安は 1,500 円程度。厳密な上限保証ではなく、ランタイム制限で超過を抑止する。

## 2. 前提

### 2.1 採用構成

```text
Discord Slash Command
  ↓
API Gateway HTTP API
  ↓
Discord Interaction Lambda
  ↓
ECS RunTask
  ↓
ECS Fargate Spot Task
  ↓
Linux container + SteamCMD + Proton/UMU + ASA dedicated server
  ↓
S3 saves/config/backups
```

### 2.2 なぜ API Gateway + Lambda を使うか

Discord の Slash Commands は Gateway 経由または HTTP Interactions Endpoint 経由で受け取れる。今回の要件では常駐 Bot プロセスを持ちたくないため、HTTP Interactions Endpoint として API Gateway + Lambda を使う。

これにより、Discord Bot 用の EC2 や常駐コンテナを不要にする。

### 2.3 ASA dedicated server の扱い

ASA dedicated server は Steam app `2430930` を SteamCMD で取得する。

SteamDB 上では `ARK: Survival Ascended Dedicated Server` は `Supported Systems: Windows` とされているため、Linux Fargate では Windows バイナリを Proton / UMU 経由で起動する。

この構成はコストと運用負荷を下げるための実用構成であり、公式の Linux native server ではない。ASA 側のアップデートにより Proton 起動が壊れる可能性がある。

## 3. 非目標

以下は初期実装では扱わない。

- 24時間常時稼働。
- EC2、Auto Scaling Group、管理対象外のVM。
- Windows Fargate。
- NAT Gateway。
- ALB / NLB。
- EFS 常用。
- 複数マップ同時起動。
- 大規模公開サーバー。
- RCON の外部公開。
- 完全なコスト上限保証。

## 4. AWS構成

## 4.1 リージョン

デフォルトは `ap-northeast-1`。

理由:

- 日本からのレイテンシを優先する。
- 少人数用のため、AWS単価より操作性を優先する。

CDK context で変更可能にする。

```json
{
  "region": "ap-northeast-1"
}
```

## 4.2 ネットワーク

### VPC

- Public Subnet のみ。
- NAT Gateway は作成しない。
- Internet Gateway は使用する。
- ECS Task は `assignPublicIp: true` で起動する。

理由:

- ASA サーバーが Steam / Discord / S3 / AWS API へ outbound 通信する必要がある。
- NAT Gateway は月額固定費が高く、今回の予算に合わない。
- Public IP 直付けが最も安い。

### Security Group

Inbound:

| Protocol | Port | Source | Purpose |
|---|---:|---|---|
| UDP | 7777 | `0.0.0.0/0` | ASA game port |
| UDP | 7778 | `0.0.0.0/0` | ASA raw/socket adjacent port |
| UDP | 27015 | `0.0.0.0/0` | Steam query port |

Outbound:

| Protocol | Port | Destination | Purpose |
|---|---:|---|---|
| ALL | ALL | `0.0.0.0/0` | Steam, Discord, S3, AWS API |

RCON port は外部公開しない。RCON はコンテナ内から `127.0.0.1` に対してのみ使う。

## 4.3 ECS

### Cluster

- `AsaCluster`
- capacity provider: `FARGATE_SPOT`
- ECS Service は作らない。
- 起動は Lambda から `RunTask` で行う。

### Task Definition

Launch type:

- Fargate
- Linux x86_64
- platform version: `LATEST`

初期値:

| Parameter | Value |
|---|---:|
| CPU | `2048` |
| Memory | `12288 MiB` |
| Ephemeral storage | `100 GiB` |
| stopTimeout | `120 seconds` |
| desiredCount | N/A; serviceを作らない |

CDK context で上書き可能にする。

```json
{
  "asaCpu": 2048,
  "asaMemoryMiB": 12288,
  "asaEphemeralStorageGiB": 100,
  "asaStopTimeoutSeconds": 120
}
```

### Capacity Provider Strategy

`RunTask` 時は以下を使う。

```json
[
  {
    "capacityProvider": "FARGATE_SPOT",
    "weight": 1,
    "base": 0
  }
]
```

Spot のキャパシティ不足時は起動失敗として Discord に通知する。
初期実装では On-Demand fallback はしない。

fallback を入れる場合は CDK context で明示的に有効化する。

```json
{
  "enableOnDemandFallback": false
}
```

## 4.4 Container image

### ECR

- `AsaServerRepository` を作る。
- CDK の `DockerImageAsset` で `container/` をビルドして ECR に push する。
- ASA server 本体は image に焼き込まない。

理由:

- ASA server 本体は大きい。
- Steam 側の更新を image rebuild なしで取り込める。
- 配布物の扱いを image artifact に混ぜない。

### Dockerfile要件

Base image:

- Debian または Ubuntu 系。
- x86_64。

インストールするもの:

- `steamcmd`
- Proton または UMU launcher
- `awscli`
- `curl`
- `jq`
- `tar`
- `zstd`
- `procps`
- `ca-certificates`
- RCON client
- Discord webhook post 用の `curl`

ディレクトリ:

```text
/asa
  /server      SteamCMD install dir
  /work        runtime work dir
  /tmp         temporary archive dir
  /scripts     entrypoint/helper scripts
```

## 4.5 S3

### Bucket

`AsaStateBucket`

設定:

- Block Public Access: enabled
- Versioning: enabled
- Encryption: S3 managed or KMS managed
- RemovalPolicy: retain by default
- Lifecycle:
  - `backups/` は 30 日後削除
  - `logs/` は 14 日後削除

Prefix:

```text
config/
  GameUserSettings.ini
  Game.ini
saves/
  current.tar.zst
backups/
  yyyy/mm/dd/yyyymmddThhmmssZ.tar.zst
runtime/
  last-ready.json
  last-stop.json
```

### セーブ方針

- 起動時に `saves/current.tar.zst` を取得して `/asa/server/ShooterGame/Saved` へ展開する。
- 起動中は 10 分ごとに snapshot を S3 に保存する。
- 正常停止時は RCON `SaveWorld` 後に final snapshot を保存する。
- Spot interruption や強制終了では final snapshot が失敗する可能性があるため、10分間隔の snapshot を主要な保険にする。

## 4.6 DynamoDB

`AsaServerStateTable`

Partition key:

- `pk: string`

固定行:

- `pk = "SERVER"`
- `pk = "BUDGET#YYYY-MM"`

`SERVER` attributes:

```json
{
  "pk": "SERVER",
  "status": "STOPPED | STARTING | RUNNING | STOPPING | ERROR",
  "taskArn": "string | null",
  "clusterArn": "string | null",
  "startedAt": "ISO8601 | null",
  "expiresAt": "ISO8601 | null",
  "publicIp": "string | null",
  "connectCommand": "open x.x.x.x:7777 | null",
  "sessionName": "string",
  "mapName": "TheIsland_WP",
  "maxPlayers": 4,
  "startedByDiscordUserId": "string | null",
  "startedFromChannelId": "string | null",
  "lastBackupAt": "ISO8601 | null",
  "lastStopReason": "string | null",
  "updatedAt": "ISO8601"
}
```

`BUDGET#YYYY-MM` attributes:

```json
{
  "pk": "BUDGET#2026-06",
  "runtimeSeconds": 0,
  "estimatedCostUsd": 0,
  "estimatedCostJpy": 0,
  "startCount": 0,
  "updatedAt": "ISO8601"
}
```

## 4.7 Secrets / Parameters

### Secrets Manager

Secrets:

```text
/asa/discord/bot-token
/asa/discord/notification-webhook-url
/asa/server/password
/asa/server/admin-password
```

### SSM Parameter Store

Non-secret parameters:

```text
/asa/discord/application-id
/asa/discord/public-key
/asa/discord/guild-id
/asa/discord/allowed-role-ids
/asa/discord/allowed-user-ids
/asa/server/session-name
/asa/server/default-map
/asa/server/max-players
```

`allowed-role-ids` と `allowed-user-ids` は JSON array string とする。

例:

```json
["123456789012345678"]
```

## 4.8 Lambda

### 4.8.1 DiscordInteractionLambda

Purpose:

- API Gateway から Discord Interactions を受ける。
- Discord request signature を検証する。
- Slash Command を処理する。
- ECS 起動・停止・状態確認を行う。

Runtime:

- Node.js 22.x
- TypeScript

Endpoint:

```text
POST /discord/interactions
```

必須処理:

1. API Gateway から raw body を取得する。
2. `X-Signature-Ed25519` と `X-Signature-Timestamp` を使って Discord signature を検証する。
3. `PING` は `PONG` を返す。
4. guild id を検証する。
5. allowed role / user を検証する。
6. command に応じて処理する。

Command handling:

| Command | Description |
|---|---|
| `/asa start` | サーバーを起動する |
| `/asa stop` | サーバーを停止する |
| `/asa status` | 状態と接続情報を返す |
| `/asa info` | 接続情報を返す |
| `/asa backup` | 起動中なら backup request を出す。停止中なら直近backup情報を返す |
| `/asa budget` | 今月の稼働時間と推定コストを返す |

`/asa start` options:

| Option | Type | Default | Validation |
|---|---|---:|---|
| `duration_hours` | integer | `4` | `1 <= n <= 8` |
| `map` | string choice | `TheIsland_WP` | allowlist |
| `max_players` | integer | `4` | `1 <= n <= 8` |
| `session_name` | string | SSM default | max 50 chars |
| `public_notify` | boolean | `true` | boolean |

Slash command response:

- `start` / `stop` は処理が長くなるため、すぐ deferred response を返す。
- 起動完了は Discord notification webhook でチャンネルに投稿する。
- `status` / `info` / `budget` は即時応答でよい。

### 4.8.2 EcsTaskEventsLambda

Purpose:

- EventBridge の ECS Task State Change を受ける。
- DynamoDB の状態を更新する。
- RUNNING / STOPPED / ERROR を Discord に通知する。
- RUNNING 時に ENI から public IP を取得する。
- Optional: Route53 A record を更新する。

Event patterns:

```json
{
  "source": ["aws.ecs"],
  "detail-type": ["ECS Task State Change"],
  "detail": {
    "clusterArn": ["<AsaClusterArn>"]
  }
}
```

RUNNING event handling:

1. `DescribeTasks` で task attachment から ENI ID を取得する。
2. `DescribeNetworkInterfaces` で public IP を取得する。
3. DynamoDB `SERVER` を `RUNNING` に更新する。
4. Discord に「タスクは起動した。ゲームサーバーのreadyには数分かかる可能性あり」と通知する。
5. Route53 が有効なら A record を更新する。

STOPPED event handling:

1. DynamoDB `SERVER` を `STOPPED` に更新する。
2. runtime seconds を今月の `BUDGET#YYYY-MM` に加算する。
3. stopped reason を記録する。
4. Discord に停止通知を送る。

### 4.8.3 StopServerLambda

Purpose:

- TTL到達時または `/asa stop` から ECS task を停止する。

Input:

```json
{
  "reason": "USER_REQUEST | TTL_EXPIRED | BUDGET_EXCEEDED",
  "requestedByDiscordUserId": "string | null"
}
```

処理:

1. DynamoDB `SERVER` を読む。
2. `RUNNING` または `STARTING` で taskArn がある場合だけ停止する。
3. `StopTask` を呼ぶ。
4. `STOPPING` に更新する。
5. Discord に停止開始を通知する。

### 4.8.4 Optional: BackupRequestLambda

初期実装では必須ではない。

`/asa backup` で起動中のコンテナに backup を要求したい場合、以下のどちらかで実装する。

Option A:

- ECS Exec を使う。
- ただし権限・実装が重くなるため初期実装では避ける。

Option B:

- S3 に `runtime/backup-request.json` を置く。
- コンテナ側が 30 秒ごとに poll して backup を実行する。

初期実装では Option B を採用する。

## 4.9 EventBridge Scheduler

`/asa start` 時に one-time schedule を作る。

例:

```text
start time: now
expiresAt: now + duration_hours
schedule: at(expiresAt)
target: StopServerLambda
payload: { "reason": "TTL_EXPIRED" }
```

サーバー停止時は schedule を削除する。

## 4.10 Route53 Optional

CDK context で以下が指定された場合のみ有効化する。

```json
{
  "hostedZoneId": "Z...",
  "domainName": "ark.example.com"
}
```

RUNNING event で A record を public IP に更新する。

TTL:

```text
60 seconds
```

Route53 がない場合は Discord に `open <public-ip>:7777` を通知する。

## 5. Discord設計

## 5.1 Discord App

必要な値:

- Application ID
- Public Key
- Bot Token
- Guild ID
- Notification Webhook URL
- Allowed Role IDs or User IDs

Interactions Endpoint URL:

```text
https://<api-id>.execute-api.<region>.amazonaws.com/discord/interactions
```

## 5.2 Slash Commands

Guild command として登録する。
Global command は反映遅延があるため初期実装では使わない。

### `/asa start`

Description:

```text
Start the private ARK: Survival Ascended server.
```

Options:

```json
[
  {
    "name": "duration_hours",
    "description": "Auto-stop after this many hours",
    "type": 4,
    "required": false,
    "min_value": 1,
    "max_value": 8
  },
  {
    "name": "map",
    "description": "Map name",
    "type": 3,
    "required": false,
    "choices": [
      { "name": "The Island", "value": "TheIsland_WP" }
    ]
  },
  {
    "name": "max_players",
    "description": "Maximum players",
    "type": 4,
    "required": false,
    "min_value": 1,
    "max_value": 8
  },
  {
    "name": "public_notify",
    "description": "Post server info to the channel",
    "type": 5,
    "required": false
  }
]
```

Behavior:

- すでに `STARTING` / `RUNNING` の場合は二重起動しない。
- 予算上限を超えている場合は起動しない。
- ECS RunTask 成功時点で「起動リクエスト受付」を返す。
- 実際の接続情報は Task RUNNING event または container ready webhook で通知する。

### `/asa stop`

Description:

```text
Stop the private ARK: Survival Ascended server.
```

Behavior:

- 停止中なら no-op。
- 起動中なら `StopServerLambda` 相当の処理を実行する。
- ASAコンテナは SIGTERM を受けて SaveWorld → S3 backup → exit を試みる。

### `/asa status`

Returns:

```text
Status: RUNNING
Map: TheIsland_WP
Players: unknown
Started: 2026-06-24T12:00:00+09:00
Expires: 2026-06-24T16:00:00+09:00
Connect: open x.x.x.x:7777
This month: 12.3h / configured limit
Estimated cost: ¥xxx
```

Player count は初期実装では unknown でよい。
将来 RCON / query による取得を追加する。

### `/asa info`

接続情報だけ返す。

- Server name
- Public IP or DNS
- Connect command
- Server password の表示有無

`server password` はデフォルトでは表示しない。
表示したい場合のみ CDK context で有効化する。

```json
{
  "allowDiscordPasswordNotification": false
}
```

### `/asa backup`

Behavior:

- 起動中なら S3 に backup request を書き込む。
- コンテナが request を拾い backup する。
- 停止中なら直近 backup の時刻を返す。

### `/asa budget`

Returns:

- 今月の起動回数。
- 今月の合計稼働時間。
- 推定コスト。
- 設定上限。

## 5.3 Discord通知

通知は `notification-webhook-url` を使ってチャンネルへ投稿する。

### 起動リクエスト受付

```text
ASA server start requested by <user>.
Map: TheIsland_WP
TTL: 4h
Status: STARTING
```

### ECS task RUNNING

```text
ASA task is running.
Public IP: x.x.x.x
Connect: open x.x.x.x:7777
Game server may still be loading. Wait for READY notification.
```

### ASA READY

コンテナ側から投稿する。

```text
ASA server is READY.
Server: <session name>
Map: TheIsland_WP
Connect: open x.x.x.x:7777
Auto-stop: 2026-06-24 16:00 JST
```

### 停止開始

```text
ASA server is stopping.
Reason: USER_REQUEST
Saving world and uploading backup to S3...
```

### 停止完了

```text
ASA server stopped.
Runtime: 2h 41m
Last backup: 2026-06-24T06:41:00Z
Reason: Essential container in task exited
```

### Spot interruption / 異常停止

```text
ASA server stopped unexpectedly or was interrupted.
Last known backup: <timestamp>
Reason: <stoppedReason>
```

## 6. ASA container runtime仕様

## 6.1 Environment variables

Task 起動時に注入する。

```text
AWS_REGION=ap-northeast-1
S3_BUCKET=<AsaStateBucket>
S3_SAVE_KEY=saves/current.tar.zst
S3_BACKUP_PREFIX=backups/
ASA_APP_ID=2430930
ASA_INSTALL_DIR=/asa/server
ASA_MAP=TheIsland_WP
ASA_SESSION_NAME=<from SSM or command option>
ASA_MAX_PLAYERS=4
ASA_SERVER_PASSWORD=<secret>
ASA_ADMIN_PASSWORD=<secret>
ASA_PORT=7777
ASA_QUERY_PORT=27015
ASA_RCON_PORT=27020
ASA_DISABLE_BATTLEYE=true
DISCORD_WEBHOOK_URL=<secret>
AUTO_BACKUP_INTERVAL_SECONDS=600
BACKUP_REQUEST_KEY=runtime/backup-request.json
```

パスワード・session name は shell escaping 問題を避けるため、初期実装では以下に制限する。

```text
^[A-Za-z0-9_.-]{1,64}$
```

## 6.2 起動処理

`entrypoint.sh` の処理順序:

1. 必須 environment variables を検証する。
2. `/asa/server` を作成する。
3. SteamCMD で ASA server を取得・更新する。
4. S3 から `saves/current.tar.zst` を取得する。存在しない場合は新規ワールドとして続行する。
5. S3 から `config/GameUserSettings.ini` と `config/Game.ini` を取得する。存在しない場合はテンプレートを生成する。
6. Proton / UMU prefix を初期化する。
7. ASA server を起動する。
8. ready 判定ループを開始する。
9. 10分ごとの backup loop を開始する。
10. `backup-request.json` の poll loop を開始する。
11. main process を wait する。

## 6.3 SteamCMD

実行例:

```bash
steamcmd \
  +force_install_dir "${ASA_INSTALL_DIR}" \
  +login anonymous \
  +app_update "${ASA_APP_ID}" validate \
  +quit
```

## 6.4 Launch command

概念上のコマンド:

```bash
ArkAscendedServer.exe \
  "${ASA_MAP}?listen?SessionName=${ASA_SESSION_NAME}?ServerPassword=${ASA_SERVER_PASSWORD}?ServerAdminPassword=${ASA_ADMIN_PASSWORD}?MaxPlayers=${ASA_MAX_PLAYERS}?Port=${ASA_PORT}?QueryPort=${ASA_QUERY_PORT}" \
  -log
```

`ASA_DISABLE_BATTLEYE=true` の場合は `-NoBattlEye` を追加する。

実際には Proton / UMU 経由で `ArkAscendedServer.exe` を起動する。

## 6.5 Ready判定

以下のいずれかで READY とみなす。

優先順位:

1. RCON 接続が成功する。
2. UDP query port が応答する。
3. server log に ready 相当の行が出る。

初期実装では RCON 成功を第一候補にする。
RCON が安定しない場合は log pattern に fallback する。

READY になったら Discord webhook に投稿する。

## 6.6 Backup

`backup.sh`:

1. RCON `SaveWorld` を実行する。
2. 5〜10秒待つ。
3. `ShooterGame/Saved` を tar.zst に固める。
4. `s3://bucket/saves/current.tar.zst` に upload する。
5. `s3://bucket/backups/yyyy/mm/dd/timestamp.tar.zst` に upload する。
6. `runtime/last-backup.json` を更新する。

例:

```bash
tar --zstd -cf /asa/tmp/current.tar.zst -C "${ASA_INSTALL_DIR}/ShooterGame" Saved
aws s3 cp /asa/tmp/current.tar.zst "s3://${S3_BUCKET}/saves/current.tar.zst"
aws s3 cp /asa/tmp/current.tar.zst "s3://${S3_BUCKET}/backups/$(date -u +%Y/%m/%d/%Y%m%dT%H%M%SZ).tar.zst"
```

## 6.7 SIGTERM handling

`entrypoint.sh` は SIGTERM / SIGINT を trap する。

処理:

1. Discord に stopping を通知する。
2. backup loop を止める。
3. RCON `SaveWorld` を実行する。
4. final backup を S3 に upload する。
5. ASA process を graceful stop する。
6. timeout したら process を kill する。

Fargate の `stopTimeout` は 120秒に設定する。
120秒以内に完了しない場合は SIGKILL される可能性がある。
そのため、停止時 backup だけに依存せず、起動中の定期 backup を必須にする。

## 7. コスト制御

## 7.1 方針

厳密な請求額制御ではなく、起動時間に基づく近似制御を行う。

理由:

- Fargate Spot 単価は変動する。
- Public IPv4、CloudWatch Logs、S3、ECR、Route53 などの副次費用がある。
- AWS Budgets は通知向けで、即時の起動拒否には別実装が必要。

## 7.2 Runtime budget guard

CDK context:

```json
{
  "monthlyBudgetJpy": 1500,
  "monthlyRuntimeHoursLimit": 80,
  "maxSessionHours": 8,
  "defaultSessionHours": 4
}
```

`/asa start` 時に以下をチェックする。

- 今月の runtime が `monthlyRuntimeHoursLimit` を超えていないか。
- 今回の `duration_hours` を足すと超えるか。
- すでに task が起動中ではないか。

超える場合は起動しない。

## 7.3 AWS Budgets optional

CDK context で有効化できる。

```json
{
  "enableAwsBudget": true,
  "budgetEmail": "user@example.com"
}
```

有効時:

- Monthly cost budget を作る。
- 80% / 100% で email 通知する。

初期実装では AWS Budgets は optional とする。

## 8. IAM

## 8.1 DiscordInteractionLambda role

Allow:

- `ecs:RunTask`
- `ecs:DescribeTasks`
- `ecs:StopTask`
- `iam:PassRole` for ECS task execution role and task role
- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:ConditionCheckItem`
- `secretsmanager:GetSecretValue` for Discord/ASA secrets
- `ssm:GetParameter`
- `ssm:GetParameters`
- `scheduler:CreateSchedule`
- `scheduler:DeleteSchedule`
- `scheduler:GetSchedule`

## 8.2 EcsTaskEventsLambda role

Allow:

- `ecs:DescribeTasks`
- `ec2:DescribeNetworkInterfaces`
- `dynamodb:GetItem`
- `dynamodb:UpdateItem`
- `secretsmanager:GetSecretValue` for Discord notification webhook
- `route53:ChangeResourceRecordSets` only if Route53 enabled

## 8.3 StopServerLambda role

Allow:

- `ecs:StopTask`
- `ecs:DescribeTasks`
- `dynamodb:GetItem`
- `dynamodb:UpdateItem`
- `secretsmanager:GetSecretValue` for Discord notification webhook
- `scheduler:DeleteSchedule`

## 8.4 ECS task execution role

Allow:

- ECR pull permissions
- CloudWatch Logs write permissions
- Secrets injection permissions

## 8.5 ECS task role

Allow:

- `s3:GetObject` for `config/*`, `saves/*`, `runtime/*`
- `s3:PutObject` for `saves/*`, `backups/*`, `runtime/*`
- `s3:ListBucket` scoped to required prefixes
- `secretsmanager:GetSecretValue` for Discord webhook and server password if not injected by execution role

Do not allow broad `s3:*`.

## 9. CDK実装方針

## 9.1 Language

- TypeScript
- AWS CDK v2
- Node.js 22.x for Lambdas

## 9.2 Repository layout

```text
.
├── README.md
├── SPEC.md
├── cdk.json
├── package.json
├── tsconfig.json
├── src
│   ├── bin
│   │   └── app.ts
│   ├── lib
│   │   └── asa-fargate-stack.ts
│   ├── lambdas
│   │   ├── discord-interactions
│   │   │   └── index.ts
│   │   ├── ecs-task-events
│   │   │   └── index.ts
│   │   └── stop-server
│   │       └── index.ts
│   └── shared
│       ├── discord.ts
│       ├── state.ts
│       ├── ecs.ts
│       ├── budget.ts
│       └── config.ts
├── container
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── backup.sh
│   ├── restore.sh
│   ├── notify-discord.sh
│   └── healthcheck.sh
└── scripts
    ├── register-discord-commands.ts
    ├── put-secrets.example.sh
    └── smoke-test.ts
```

## 9.3 CDK Constructs

`AsaFargateStack` に以下を含める。

- VPC
- SecurityGroup
- S3 Bucket
- DynamoDB Table
- ECR DockerImageAsset
- ECS Cluster
- Fargate TaskDefinition
- CloudWatch LogGroup
- Lambda functions
- API Gateway HTTP API
- EventBridge rule for ECS task state change
- Optional Route53 record permission
- Optional AWS Budget
- CDK Outputs

## 9.4 CDK Outputs

出力する。

```text
DiscordInteractionsEndpointUrl
AsaStateBucketName
AsaClusterName
AsaTaskDefinitionArn
AsaSecurityGroupId
AsaStateTableName
OptionalDomainName
```

## 10. Discord command registration

`scripts/register-discord-commands.ts` を実装する。

Input env:

```text
DISCORD_BOT_TOKEN
DISCORD_APPLICATION_ID
DISCORD_GUILD_ID
```

処理:

- Discord API の guild application commands bulk overwrite を使う。
- `/asa` command group を登録する。
- 既存の guild command を上書きする。

実行例:

```bash
DISCORD_BOT_TOKEN=... \
DISCORD_APPLICATION_ID=... \
DISCORD_GUILD_ID=... \
npm run discord:register
```

## 11. Deployment flow

## 11.1 初回セットアップ

```bash
npm install
npm run build
cdk bootstrap
```

## 11.2 Secrets投入

`scripts/put-secrets.example.sh` を参考に手動投入する。

```bash
aws secretsmanager create-secret \
  --name /asa/discord/bot-token \
  --secret-string '<discord bot token>'

aws secretsmanager create-secret \
  --name /asa/discord/notification-webhook-url \
  --secret-string '<discord webhook url>'

aws secretsmanager create-secret \
  --name /asa/server/password \
  --secret-string '<join password>'

aws secretsmanager create-secret \
  --name /asa/server/admin-password \
  --secret-string '<admin password>'
```

SSM parameters:

```bash
aws ssm put-parameter --name /asa/discord/application-id --type String --value '<application id>'
aws ssm put-parameter --name /asa/discord/public-key --type String --value '<public key>'
aws ssm put-parameter --name /asa/discord/guild-id --type String --value '<guild id>'
aws ssm put-parameter --name /asa/discord/allowed-role-ids --type String --value '["..."]'
aws ssm put-parameter --name /asa/discord/allowed-user-ids --type String --value '["..."]'
aws ssm put-parameter --name /asa/server/session-name --type String --value 'private-asa'
aws ssm put-parameter --name /asa/server/default-map --type String --value 'TheIsland_WP'
aws ssm put-parameter --name /asa/server/max-players --type String --value '4'
```

## 11.3 Deploy

```bash
cdk deploy \
  -c region=ap-northeast-1 \
  -c monthlyBudgetJpy=1500 \
  -c monthlyRuntimeHoursLimit=80
```

## 11.4 Discord Developer Portal

- Interactions Endpoint URL に CDK output の `DiscordInteractionsEndpointUrl` を設定する。
- Discord の PING 検証が通ることを確認する。

## 11.5 Slash commands登録

```bash
npm run discord:register
```

## 12. Operational behavior

## 12.1 起動

1. User runs `/asa start duration_hours:4`.
2. Lambda validates signature and permissions.
3. Lambda checks DynamoDB state.
4. Lambda checks budget guard.
5. Lambda updates state to `STARTING` conditionally.
6. Lambda runs ECS task with Fargate Spot.
7. Lambda creates one-time stop schedule.
8. Lambda returns deferred Discord response.
9. EventBridge sees task `RUNNING`.
10. EcsTaskEventsLambda resolves public IP and posts Discord notification.
11. Container restores saves and starts ASA.
12. Container posts READY notification.

## 12.2 停止

1. User runs `/asa stop` or TTL schedule fires.
2. StopServerLambda calls `StopTask`.
3. ECS sends SIGTERM to container.
4. Container runs final backup.
5. Task stops.
6. EventBridge sees `STOPPED`.
7. EcsTaskEventsLambda updates DynamoDB and budget.
8. Discord receives stopped notification.

## 12.3 異常終了

- EventBridge `STOPPED` reason を Discord に通知する。
- DynamoDB state は `STOPPED` に戻す。
- `lastBackupAt` が古い場合は warning を付ける。

## 13. Observability

### CloudWatch Logs

Log groups:

```text
/asa/lambda/discord-interactions
/asa/lambda/ecs-task-events
/asa/lambda/stop-server
/asa/ecs/server
```

Retention:

```text
7 days
```

### Metrics

初期実装では custom metrics は optional。

将来追加候補:

- start count
- start failures
- task interruptions
- backup success/failure
- ready latency seconds
- runtime hours

## 14. Security

- Discord request signature を必ず検証する。
- Discord guild id を検証する。
- allowed role / user を検証する。
- Server admin password は Discord に投稿しない。
- Server join password もデフォルトでは投稿しない。
- RCON は外部公開しない。
- S3 bucket は public access block を有効にする。
- IAM は prefix/resource scoped にする。
- CloudWatch logs に秘密値を出力しない。
- API Gateway は Discord署名検証を前提に公開する。

## 15. Failure cases and expected behavior

| Case | Expected behavior |
|---|---|
| Discord signature invalid | 401 |
| Unauthorized user/role | ephemeral deny message |
| Already running | current info を返す |
| Fargate Spot capacity unavailable | state を ERROR/STOPPED に戻し Discord 通知 |
| SteamCMD update fails | task exits, Discord 通知 |
| S3 restore fails because no save exists | new world として起動 |
| S3 restore fails due to access error | task exits |
| Ready timeout | Discord に warning。task は継続 |
| Backup fails | Discord に warning。task は継続 |
| TTL stop fails | Discord に warning。次回 status で検出 |
| ECS task exits unexpectedly | EventBridge で STOPPED に更新 |

## 16. Testing requirements

## 16.1 Unit tests

- Discord signature verification
- Command parser
- Permission checker
- Budget guard
- DynamoDB state transition
- Public IP extraction from ECS task attachments
- Discord message formatter

## 16.2 CDK tests

- `cdk synth` が通る。
- EC2 Instance / AutoScalingGroup が作られていない。
- NAT Gateway が作られていない。
- ALB / NLB が作られていない。
- Security Group inbound が UDP 7777, 7778, 27015 のみ。
- TaskDefinition が Fargate Linux x86_64。
- Ephemeral storage が context 通り。
- stopTimeout が 120 秒。

## 16.3 Container tests

- Docker image build が通る。
- `entrypoint.sh` が shellcheck を通る。
- 必須 env 不足時に fail fast する。
- backup script が mock directory を tar.zst 化できる。
- restore script が tar.zst を展開できる。

## 16.4 Manual integration tests

1. `/asa status` が `STOPPED` を返す。
2. `/asa start duration_hours:1` で ECS task が作られる。
3. Discord に STARTING 通知が来る。
4. ECS task が RUNNING になり public IP が通知される。
5. ASA READY 通知が来る。
6. ゲームから `open <ip>:7777` で接続できる。
7. `/asa backup` で S3 backup が増える。
8. `/asa stop` で task が停止する。
9. S3 `saves/current.tar.zst` が更新される。
10. 次回起動時にセーブが復元される。

## 17. Codex implementation checklist

Codex は以下の順で実装すること。

1. CDK TypeScript project を scaffold する。
2. `AsaFargateStack` を作る。
3. VPC public subnet only を作る。
4. S3 bucket, DynamoDB table, ECS cluster, task definition を作る。
5. DockerImageAsset で `container/` を image build する。
6. DiscordInteractionLambda を実装する。
7. StopServerLambda を実装する。
8. EcsTaskEventsLambda を実装する。
9. API Gateway HTTP API を Lambda に接続する。
10. EventBridge ECS Task State Change rule を作る。
11. EventBridge Scheduler one-time stop を start command から作る。
12. Discord command registration script を作る。
13. container scripts を作る。
14. README に setup/deploy/runbook を書く。
15. unit tests / CDK tests を追加する。
16. `npm run build`, `npm test`, `cdk synth` が通る状態にする。

## 18. References

- AWS Fargate pricing: https://aws.amazon.com/fargate/pricing/
- Amazon ECS Fargate task ephemeral storage: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html
- Amazon ECS Fargate Spot capacity providers: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html
- Windows containers on AWS Fargate considerations: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/windows-considerations.html
- Discord Interactions & Commands: https://docs.discord.com/developers/platform/interactions
- Discord Application Commands: https://docs.discord.com/developers/interactions/application-commands
- SteamDB ASA dedicated server app 2430930: https://steamdb.info/app/2430930/info/
- ARK Official Community Wiki dedicated server setup: https://ark.wiki.gg/wiki/Dedicated_server_setup
