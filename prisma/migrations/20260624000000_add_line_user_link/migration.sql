-- Phase 2 β 解消 (docs/smb-dx-pivot-plan.md §4 Phase 2「LINE 公式アカウント連携」):
-- LINE ユーザーとテナントメンバーを紐付けるための列を User に追加する。
-- 紐付け後は LINE 起票チケットの起票者が本人になり、自己解決 UI (creatorId = 自分) が開通する。

-- 確定リンク (紐付け済み LINE ユーザー ID。未連携は NULL)
ALTER TABLE "User" ADD COLUMN "lineUserId" TEXT;
-- 発行中ワンタイムコードの SHA-256 ハッシュ (生コードは保存しない)
ALTER TABLE "User" ADD COLUMN "lineLinkCodeHash" TEXT;
-- 上記コードの失効時刻 (NULL なら発行中コードなし)
ALTER TABLE "User" ADD COLUMN "lineLinkCodeExpiresAt" TIMESTAMP(3);

-- ワンタイムコードのハッシュは一意 (同じハッシュが 2 件存在しない)
CREATE UNIQUE INDEX "User_lineLinkCodeHash_key" ON "User"("lineLinkCodeHash");

-- テナント内で 1 LINE ユーザー = 1 メンバーを保証する複合一意制約。
-- PostgreSQL は NULL を互いに区別するため、未連携 (lineUserId IS NULL) のユーザーは何人でも共存できる。
CREATE UNIQUE INDEX "User_tenantId_lineUserId_key" ON "User"("tenantId", "lineUserId");
