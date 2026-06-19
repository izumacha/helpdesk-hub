-- Phase 2 / メール取り込み (docs/smb-dx-pivot-plan.md §4 Phase 2・§5.3):
-- テナント専用の転送アドレス (例: <inboundToken>@inbox.helpdesk-hub.app) を表す
-- ローカルパート識別子 "inboundToken" を Tenant に追加する。受信メールの Webhook
-- (/api/inbound/email) がこの値からテナントを特定して問い合わせ (Ticket) を起票する。
-- 既存テナントのバックフィル中は NULL を許容し、@unique でテナント一意を保証する。

-- Tenant に inboundToken 列を追加 (NULL 許容)
ALTER TABLE "Tenant" ADD COLUMN "inboundToken" TEXT;

-- inboundToken は一意 (同じトークンを 2 テナントが持たない)。NULL は複数許容される
CREATE UNIQUE INDEX "Tenant_inboundToken_key" ON "Tenant"("inboundToken");
