-- Phase 2「LINE 公式アカウント連携 (β)」の冪等化 (docs/smb-dx-pivot-plan.md §4):
-- LINE は Webhook 応答が遅延/未受信だと同一メッセージを 5 分以内に再送する (at-least-once)。
-- EmailThreadRef と同じ「メッセージ ID → チケット」対応表パターンで、再送時の二重起票を防ぐ。
-- @@unique([tenantId, lineMessageId]) でテナント内一意にし、別テナントのメッセージ ID で
-- 誤って既存起票を再利用させない (クロステナント漏洩防止)。

CREATE TABLE "LineMessageRef" (
    "id" TEXT NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticketId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "LineMessageRef_pkey" PRIMARY KEY ("id")
);

-- テナント内でメッセージ ID は一意 (再送での二重起票防止)
CREATE UNIQUE INDEX "LineMessageRef_tenantId_lineMessageId_key" ON "LineMessageRef"("tenantId", "lineMessageId");

-- チケット削除の連鎖や逆引きを高速化するインデックス
CREATE INDEX "LineMessageRef_ticketId_idx" ON "LineMessageRef"("ticketId");

-- テナントスコープ検索を高速化するインデックス
CREATE INDEX "LineMessageRef_tenantId_idx" ON "LineMessageRef"("tenantId");

-- 紐づくチケットへの外部キー (チケット削除で対応表も連鎖削除)
ALTER TABLE "LineMessageRef"
    ADD CONSTRAINT "LineMessageRef_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 所属テナントへの外部キー (テナント削除で対応表も連鎖削除)
ALTER TABLE "LineMessageRef"
    ADD CONSTRAINT "LineMessageRef_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
