# データベースバックアップ運用ガイド

Phase 4「監査ログ / バックアップ自動化」(`docs/smb-dx-pivot-plan.md` §4) の運用手順。
PostgreSQL を定期的にダンプし、世代管理しながら保管する。

## スクリプト

| スクリプト | 役割 |
| --- | --- |
| `scripts/backup-db.sh` | `pg_dump` で custom 形式 (圧縮込み) のダンプを作成し、古い世代を削除する |
| `scripts/restore-db.sh` | `pg_restore` でダンプから復元する（**既存データを上書き**） |

npm からも実行できる:

```bash
npm run db:backup           # バックアップ作成 + 世代管理
npm run db:backup -- --dry-run  # 実行内容だけ確認（dump しない）
npm run db:restore -- var/backups/helpdesk_hub_YYYYMMDD_HHMMSS.dump
```

## 設定（環境変数）

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | （必須） | ダンプ対象 PostgreSQL の接続文字列 |
| `BACKUP_DIR` | `./var/backups` | ダンプの保存先。本番では永続ボリュームを指定する |
| `BACKUP_RETENTION_DAYS` | `14` | 保持日数。これより古い `*.dump` は自動削除される |

ダンプは機微データを含むため、`var/backups/` は `.gitignore` 済み（リポジトリにコミットしない）。

## 自動化の選択肢

### 1. GitHub Actions（`.github/workflows/backup.yml`）

毎日 JST 03:00（cron `0 18 * * *` UTC）に実行。手動実行も可。
リポジトリ Secret `BACKUP_DATABASE_URL` を設定すると有効化され、ダンプを artifact として
7 日間保持する。**未設定ならジョブは安全に no-op で終了する**（fail-closed）。

> ⚠️ artifact には本番データが含まれ得る。アクセス権限を絞り、可能なら読み取り専用 DB ロールを
> `BACKUP_DATABASE_URL` に使う。機微データを GitHub に置きたくない場合は次のホスト cron を使う。

### 2. ホスト cron（機微データを外部に出さない運用）

本番サーバー（または DB に到達できるホスト）の crontab に登録する:

```cron
# 毎日 03:00 にバックアップ（出力は syslog/logger 等へ）
0 3 * * * cd /opt/helpdesk-hub && DATABASE_URL="postgresql://backup_ro:***@localhost:5432/helpdesk_hub" \
    BACKUP_DIR=/var/backups/helpdesk-hub BACKUP_RETENTION_DAYS=30 \
    bash scripts/backup-db.sh >> /var/log/helpdesk-backup.log 2>&1
```

### 3. Docker 環境

`docker compose` 構成では、`db` コンテナに `pg_dump` が同梱されている。ホストから:

```bash
docker compose exec -T db pg_dump --format=custom --no-owner --no-privileges \
    -U postgres helpdesk_hub > "var/backups/helpdesk_hub_$(date +%Y%m%d_%H%M%S).dump"
```

または、アプリのワークスペースをマウントしたコンテナ内で `scripts/backup-db.sh` を実行する。

## 復元手順

1. 復元先 `DATABASE_URL` を確認する（**上書きされる**ので接続先を間違えない）。
2. 復元を実行する:

   ```bash
   DATABASE_URL="postgresql://postgres:***@localhost:5432/helpdesk_hub" \
       npm run db:restore -- var/backups/helpdesk_hub_YYYYMMDD_HHMMSS.dump
   ```

3. 復元後、`npm run db:generate` 済みのアプリで起動確認を行う。

## 検証（リストアテスト）

バックアップは「復元できて初めて有効」。定期的に空 DB へリストアして整合を確認する:

```bash
createdb helpdesk_hub_restore_test
DATABASE_URL="postgresql://postgres:***@localhost:5432/helpdesk_hub_restore_test" \
    npm run db:restore -- var/backups/<最新>.dump
dropdb helpdesk_hub_restore_test
```
