-- フォローアップ (2026-07-11): 監査で発見したギャップの解消。
-- 招待リンク発行 (createInvitation / createInvitationsBulk) は agent 権限を新しい人物に
-- 付与しうる操作であり、SSO/LINE/通知チャネル設定と同じ「管理者による設定変更」でありながら
-- SettingsAuditLog の対象から漏れていた。
ALTER TYPE "SettingsAuditAction" ADD VALUE 'invitation_issue';
