-- §4.3 フォローアップ (2026-07-10): Stripe Webhook 経由でテナントの Pro→Lite 強制モード変更
-- (shouldResetMode, プラン失効/ダウングレード時) が SettingsAuditLog に一切記録されておらず、
-- 「誰がいつ Pro モードに切り替えたか」を追えるはずの §4.3 の意図から漏れていた。
-- この変更はユーザー操作ではなく Stripe イベント起因のシステム操作のため、操作したユーザーが
-- 存在しない。actorId を NULL 許容にし、NULL = システムによる自動変更として表現する。
ALTER TABLE "SettingsAuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
