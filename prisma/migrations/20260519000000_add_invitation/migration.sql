-- Phase 0 / マルチテナント基盤 (docs/smb-dx-pivot-plan.md §4 Phase 0・§7.1):
-- admin が発行する「メンバー招待リンク」のワンタイムトークン保管テーブルを追加する。
-- MagicLinkToken と同じく生トークンは URL のみで運び、DB には SHA-256 ハッシュだけ保存する。
-- MagicLinkToken と違い、発行時点で「どのテナントに・どの権限で参加させるか」が確定しているため
-- tenantId / role を必ず持つ (受諾時にリクエスト入力からテナントを注入させない = クロステナント参加の防止)。

CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'requester',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- tokenHash は一意制約 (同じハッシュが 2 件存在しない)
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- テナント単位の一覧・掃除を高速化するインデックス
CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");

-- 期限切れ招待の一括削除を高速化するインデックス
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- 参加先テナントへの外部キー (テナント削除で招待も連鎖削除)
ALTER TABLE "Invitation"
    ADD CONSTRAINT "Invitation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
