-- Phase 1 / マジックリンク認証 (docs/smb-dx-pivot-plan.md §3.1):
-- メールリンクでログインするためのワンタイムトークン保管テーブルを追加する。
-- 生トークンは URL のみで運ばれ、DB には SHA-256 ハッシュだけを保存する。
-- 発行時点ではユーザー (= テナント) が未確定のため、本テーブルは tenantId を持たない。
-- 消費時に email から User を引き直し、User.tenantId をセッションに載せる方式。

CREATE TABLE "MagicLinkToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- tokenHash は一意制約 (同じハッシュが 2 件存在しない)
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash");

-- email 単位の掃除・将来のレート制限カウント用インデックス
CREATE INDEX "MagicLinkToken_email_idx" ON "MagicLinkToken"("email");

-- 期限切れトークンの一括削除を高速化するインデックス
CREATE INDEX "MagicLinkToken_expiresAt_idx" ON "MagicLinkToken"("expiresAt");
