-- §4.3 フォローアップ (2026-07-10): Stripe Webhook 経由でテナントの Pro→Lite 強制モード変更
-- (shouldResetMode, プラン失効/ダウングレード時) が SettingsAuditLog に一切記録されておらず、
-- 「誰がいつ Pro モードに切り替えたか」を追えるはずの §4.3 の意図から漏れていた。
-- この変更はユーザー操作ではなく Stripe イベント起因のシステム操作のため、操作したユーザーが
-- 存在しない。actorId を NULL 許容にし、NULL = システムによる自動変更として表現する。
--
-- /code-review ultra 指摘対応: actorId を必須 (String) から任意 (String?) に変えると、
-- schema.prisma 上のリレーションも必須から任意になり、Prisma が推論する外部キーの
-- 参照アクション既定値も Restrict (必須リレーション) から SetNull (任意リレーション) に
-- 変わる。当初の本マイグレーションは ALTER COLUMN だけで既存の
-- ON DELETE RESTRICT 制約 (20260709020000_add_settings_audit_log で作成) を
-- そのまま残していたため、schema.prisma が implicit に期待する SetNull と実 DB の
-- 制約が食い違ったまま `prisma migrate deploy` されてしまう不備があった
-- (`npx prisma migrate diff --from-schema-datamodel <変更前> --to-schema-datamodel <変更後> --script`
-- で実際に生成される SQL と突き合わせて確認済み)。外部キー制約も張り直す。
-- DropForeignKey
ALTER TABLE "SettingsAuditLog" DROP CONSTRAINT "SettingsAuditLog_actorId_fkey";

-- AlterTable
ALTER TABLE "SettingsAuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
