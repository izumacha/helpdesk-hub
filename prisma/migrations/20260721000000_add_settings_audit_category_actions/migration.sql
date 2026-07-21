-- フォローアップ (2026-07-21): 監査で発見したギャップの解消。
-- カテゴリは Location (拠点) と同じ「テナント全体の設定」でありながら、作成・更新・削除の
-- いずれも監査対象から漏れていた (location_create/update/delete と同じ粒度で追加する)。
ALTER TYPE "SettingsAuditAction" ADD VALUE 'category_create';
ALTER TYPE "SettingsAuditAction" ADD VALUE 'category_update';
ALTER TYPE "SettingsAuditAction" ADD VALUE 'category_delete';
