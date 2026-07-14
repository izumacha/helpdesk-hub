-- フォローアップ (2026-07-14 #2): 監査で発見したギャップの解消。
-- テナント + 初代管理者の作成 (運用者による createTenant / セルフサーブサインアップの
-- completeSignup のいずれも) は §4.5 の invitation_issue (agent 権限付与) と同種の
-- 「新しい権限を付与する操作」であり、それより強い admin 権限そのものを付与する操作
-- にもかかわらず監査対象から漏れていた。
ALTER TYPE "SettingsAuditAction" ADD VALUE 'tenant_create';
