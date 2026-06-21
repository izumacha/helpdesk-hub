-- Phase 2「スレッド継続 (In-Reply-To ヘッダで紐付け)」(docs/smb-dx-pivot-plan.md §4 / L130):
-- 受信起票メール / 担当者の返信メールの Message-ID を、紐づくチケットと一緒に保管するテーブルを追加する。
-- 後続の返信メールが In-Reply-To / References でこれらの Message-ID を参照してきたとき、
-- 新規起票せず既存チケットへコメント追記する逆引き (Message-ID → ticket) に使う。
-- @@unique([tenantId, messageId]) でテナント内一意にし、別テナントの Message-ID でスレッドを
-- 乗っ取られないようにする (クロステナント漏洩防止)。

CREATE TABLE "EmailThreadRef" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticketId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "EmailThreadRef_pkey" PRIMARY KEY ("id")
);

-- テナント内で Message-ID は一意 (スレッド乗っ取り・二重取り込み防止)
CREATE UNIQUE INDEX "EmailThreadRef_tenantId_messageId_key" ON "EmailThreadRef"("tenantId", "messageId");

-- チケット削除の連鎖や逆引きを高速化するインデックス
CREATE INDEX "EmailThreadRef_ticketId_idx" ON "EmailThreadRef"("ticketId");

-- テナントスコープ検索を高速化するインデックス
CREATE INDEX "EmailThreadRef_tenantId_idx" ON "EmailThreadRef"("tenantId");

-- 紐づくチケットへの外部キー (チケット削除で対応表も連鎖削除)
ALTER TABLE "EmailThreadRef"
    ADD CONSTRAINT "EmailThreadRef_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 所属テナントへの外部キー (テナント削除で対応表も連鎖削除)
ALTER TABLE "EmailThreadRef"
    ADD CONSTRAINT "EmailThreadRef_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
