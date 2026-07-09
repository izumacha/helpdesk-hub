-- §4.2 フォローアップ: 監査ログ (/audit) が TicketHistory しか記録しておらず、
-- SSO/LINE 連携/通知チャネル設定の変更が監査対象から漏れていたギャップを解消する。
-- 変更前後の値 (oldValue/newValue) は記録しない設計 (これらの設定は channelSecret /
-- idpX509Cert / chatworkApiToken 等の秘匿情報を含むため)。「誰が・いつ・何をしたか」だけを記録する。
CREATE TYPE "SettingsAuditAction" AS ENUM (
    'sso_config_update',
    'sso_config_delete',
    'line_config_update',
    'line_config_delete',
    'notification_channels_update'
);

CREATE TABLE "SettingsAuditLog" (
    "id" TEXT NOT NULL,
    "action" "SettingsAuditAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,

    CONSTRAINT "SettingsAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SettingsAuditLog_tenantId_createdAt_idx" ON "SettingsAuditLog"("tenantId", "createdAt");

-- 外部キー (テナント削除で監査ログも連鎖削除)
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 外部キー (操作者ユーザー。ユーザー削除は明示的にハンドリングするため Restrict)
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
