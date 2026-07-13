-- docs/smb-dx-pivot-plan.md §7.1「30 分で運用開始」シナリオの第一歩 (セルフサーブサインアップ) に
-- 対応するトークンテーブル。MagicLinkToken と同じ構造 (email / tokenHash / expiresAt / consumedAt)。

-- CreateTable
CREATE TABLE "SignupToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignupToken_tokenHash_key" ON "SignupToken"("tokenHash");

-- CreateIndex
CREATE INDEX "SignupToken_email_idx" ON "SignupToken"("email");

-- CreateIndex
CREATE INDEX "SignupToken_expiresAt_idx" ON "SignupToken"("expiresAt");
