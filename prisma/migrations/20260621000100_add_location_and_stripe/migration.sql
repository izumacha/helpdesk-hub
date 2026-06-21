-- Phase 4: 多店舗・多拠点対応 + Stripe Billing 連携
-- docs/smb-dx-pivot-plan.md Phase 4「多店舗・多拠点対応」および「サブスク課金（Stripe Billing）」

-- SubscriptionPlan 列挙型を追加 (Stripe 課金プラン: free / standard / pro)
CREATE TYPE "SubscriptionPlan" AS ENUM ('free', 'standard', 'pro');

-- Tenant テーブルに Stripe 課金フィールドを追加
-- subscriptionPlan: 現在の課金プラン (既定 free)
ALTER TABLE "Tenant" ADD COLUMN "subscriptionPlan" "SubscriptionPlan" NOT NULL DEFAULT 'free';
-- stripeCustomerId: Stripe の Customer ID (cu_xxx)
ALTER TABLE "Tenant" ADD COLUMN "stripeCustomerId" TEXT;
-- stripeSubscriptionId: Stripe の Subscription ID (sub_xxx)
ALTER TABLE "Tenant" ADD COLUMN "stripeSubscriptionId" TEXT;
-- stripeSubscriptionStatus: Stripe の subscription.status 文字列 ("active" | "trialing" 等)
ALTER TABLE "Tenant" ADD COLUMN "stripeSubscriptionStatus" TEXT;

-- Location テーブル (テナント内の店舗・拠点を管理する)
CREATE TABLE "Location" (
    "id"          TEXT        NOT NULL,
    "name"        TEXT        NOT NULL,
    "description" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId"    TEXT        NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- Location のインデックス
-- テナントスコープ検索用
CREATE INDEX "Location_tenantId_idx" ON "Location"("tenantId");
-- テナント内で拠点名は一意 (重複登録を防ぐ)
CREATE UNIQUE INDEX "Location_tenantId_name_key" ON "Location"("tenantId", "name");

-- Location → Tenant の外部キー制約 (テナント削除で拠点も連鎖削除)
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ticket テーブルに locationId を追加 (拠点との紐づけ。null = 拠点未指定)
ALTER TABLE "Ticket" ADD COLUMN "locationId" TEXT;

-- locationId のインデックス (拠点で絞り込む一覧用)
CREATE INDEX "Ticket_locationId_idx" ON "Ticket"("locationId");

-- Ticket.locationId → Location の外部キー制約 (拠点削除時は null に戻す)
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
