-- 監査で発見したギャップ (2026-07-20): Stripe Webhook はイベントの配信順序を保証しない
-- (リトライ・ネットワーク遅延により、古いイベントが新しいイベントより後に届くことがある)。
-- 直近に適用した Stripe イベントの発生時刻 (event.created) を保持し、次回以降の Webhook 処理で
-- 「保存済みの時刻より古いイベントは適用しない」CAS (compare-and-swap) の比較対象にする。

-- AlterTable: 既存行は未処理として扱うため NULL 許容・既定値なしで追加する
ALTER TABLE "Tenant" ADD COLUMN "stripeEventProcessedAt" TIMESTAMP(3);
