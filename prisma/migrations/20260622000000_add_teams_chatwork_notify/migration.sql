-- Phase 4: Microsoft Teams / Chatwork 外部通知チャネルの設定をテナント単位で保持するカラムを追加。
-- Teams は Slack とペイロード形式が異なる (Adaptive Card) ため専用カラム teamsWebhookUrl に格納する。
-- Chatwork は Webhook ではなく REST API を使うため、API トークンと投稿先ルーム ID を保持する。
-- ALTER TABLE ADD COLUMN のため既存行はすべて null (= 各チャネル通知無効) で補完される。
ALTER TABLE "Tenant" ADD COLUMN "teamsWebhookUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "chatworkApiToken" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "chatworkRoomId" TEXT;
