-- §4.3 フォローアップ: 監査で発見したギャップ (テナントモード切替・拠点 CRUD・メール取り込み
-- 転送先アドレス再発行が SettingsAuditLog の対象から漏れていた) の解消。
-- SSO/LINE/通知チャネルと同じ「管理者による設定変更」の 5 種類を SettingsAuditAction に追加する。
ALTER TYPE "SettingsAuditAction" ADD VALUE 'tenant_mode_update';
ALTER TYPE "SettingsAuditAction" ADD VALUE 'location_create';
ALTER TYPE "SettingsAuditAction" ADD VALUE 'location_update';
ALTER TYPE "SettingsAuditAction" ADD VALUE 'location_delete';
ALTER TYPE "SettingsAuditAction" ADD VALUE 'inbound_token_regenerate';
