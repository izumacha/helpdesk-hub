-- Phase 4: Slack / Teams 外部通知チャネルの Webhook URL をテナント単位で保持するカラムを追加。
-- null なら通知無効、設定時は Slack Incoming Webhook URL を格納する。
-- ALTER TABLE ADD COLUMN のため既存行はすべて null (= 通知無効) で補完される。
ALTER TABLE "Tenant" ADD COLUMN "slackWebhookUrl" TEXT;
