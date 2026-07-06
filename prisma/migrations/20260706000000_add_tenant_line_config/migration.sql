-- Phase 2 フォローアップ (docs/smb-dx-pivot-plan.md §4 Phase 2.1): テナント単位の LINE 公式アカウント
-- 連携設定テーブルを追加する。従来は環境変数で 1 デプロイ環境 / 1 テナントに決め打ちしていた
-- LINE Webhook 署名検証・Messaging API push の認証情報を、テナントごとの DB 設定に切り替える。

-- LINE チャネル設定テーブル本体
CREATE TABLE "TenantLineConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelSecret" TEXT NOT NULL,
    "channelAccessToken" TEXT NOT NULL,
    "botUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantLineConfig_pkey" PRIMARY KEY ("id")
);

-- 1 テナント 1 設定 (1:1) を担保する一意インデックス
CREATE UNIQUE INDEX "TenantLineConfig_tenantId_key" ON "TenantLineConfig"("tenantId");

-- 1 LINE チャネル (Bot User ID) につき 1 テナントだけが名乗れるようにする一意インデックス
-- (クロステナント混線防止: 同じチャネルを 2 テナントが同時に登録できない)
CREATE UNIQUE INDEX "TenantLineConfig_botUserId_key" ON "TenantLineConfig"("botUserId");

-- テナント削除時に LINE 連携設定も連鎖削除する外部キー制約
ALTER TABLE "TenantLineConfig"
    ADD CONSTRAINT "TenantLineConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
