-- 監査で発見したギャップ: 外部通知チャネル (Slack/Teams/Chatwork) の送信失敗はサーバーログにしか
-- 残らず、管理者が Webhook URL の失効・トークン失効に気づく手段が無かった。
-- チャネルごとに直近の失敗日時・メッセージだけを追加する (履歴は持たない。成功したら null に戻す)。
ALTER TABLE "Tenant" ADD COLUMN "slackLastFailureAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "slackLastFailureMessage" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "teamsLastFailureAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "teamsLastFailureMessage" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "chatworkLastFailureAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "chatworkLastFailureMessage" TEXT;
