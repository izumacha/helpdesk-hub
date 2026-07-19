-- issue-backlog #20 フォローアップ: SLA 期限接近 (警告帯) の通知機能を追加する。
-- POST /api/internal/sla-reminders (定期実行 cron) が、resolutionDueAt が警告帯に入った
-- 未解決チケットの担当者へアプリ内通知を送るために使う。

-- AlterEnum: 通知種別に SLA 期限接近を追加する
-- PostgreSQL の ALTER TYPE ... ADD VALUE は DDL トランザクション外でのみ実行できるが、
-- Prisma のマイグレーションエンジンがこの制約を検知して自動的にトランザクション外で実行するため、
-- 20260707000000_add_notification_type_priority_changed と同様に特別な設定は不要。
-- IF NOT EXISTS で冪等性を保つ。
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'slaDueSoon';

-- AlterTable: 「どの resolutionDueAt に対して通知済みか」を保持する冪等化フラグ。
-- 既存行は未通知として扱うため NULL 許容・既定値なしで追加する。
ALTER TABLE "Ticket" ADD COLUMN "slaReminderNotifiedForDueAt" TIMESTAMP(3);
