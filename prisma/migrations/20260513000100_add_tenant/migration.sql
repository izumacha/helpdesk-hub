-- Phase 0 / SMB ピボット (docs/smb-dx-pivot-plan.md §5.1):
-- Tenant モデルを導入し、既存全レコードを単一のデフォルトテナントへバックフィルする。
-- 既存 dev DB に既にデータが入っている場合でも安全に通すため、Prisma 自動生成の
-- "ADD COLUMN tenantId NOT NULL" 直書きではなく、以下の順序で適用する:
--   1) Tenant テーブル + enum を先に作成
--   2) デフォルト Tenant 1 件を INSERT
--   3) 各テーブルに tenantId を NULL 許容で追加
--   4) UPDATE で 'default-tenant' にバックフィル
--   5) NOT NULL 制約を有効化し、FK を張る
--   6) Category の name 単一 UNIQUE を (tenantId, name) 複合 UNIQUE に置換
--   7) テナントスコープ検索用のインデックスを追加

-- 1) enum と Tenant テーブル
CREATE TYPE "TenantMode" AS ENUM ('lite', 'pro');

CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "TenantMode" NOT NULL DEFAULT 'lite',
    "industry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- 2) デフォルト Tenant を投入 (id='default-tenant'、Lite モード)
INSERT INTO "Tenant" ("id", "name", "mode", "createdAt")
VALUES ('default-tenant', 'デフォルト組織', 'lite', CURRENT_TIMESTAMP);

-- 3) tenantId カラムを NULL 許容で追加 (バックフィルのため一旦 nullable)
ALTER TABLE "User"         ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Category"     ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Ticket"       ADD COLUMN "tenantId" TEXT;
ALTER TABLE "FaqCandidate" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "tenantId" TEXT;

-- 4) 既存全レコードをデフォルト Tenant に紐付け
UPDATE "User"         SET "tenantId" = 'default-tenant' WHERE "tenantId" IS NULL;
UPDATE "Category"     SET "tenantId" = 'default-tenant' WHERE "tenantId" IS NULL;
UPDATE "Ticket"       SET "tenantId" = 'default-tenant' WHERE "tenantId" IS NULL;
UPDATE "FaqCandidate" SET "tenantId" = 'default-tenant' WHERE "tenantId" IS NULL;
UPDATE "Notification" SET "tenantId" = 'default-tenant' WHERE "tenantId" IS NULL;

-- 5) NOT NULL 制約と外部キーを追加
ALTER TABLE "User"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Category"     ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Ticket"       ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "FaqCandidate" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "User"
    ADD CONSTRAINT "User_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Category"
    ADD CONSTRAINT "Category_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ticket"
    ADD CONSTRAINT "Ticket_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FaqCandidate"
    ADD CONSTRAINT "FaqCandidate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification"
    ADD CONSTRAINT "Notification_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) Category の name 単一 UNIQUE を撤廃し、(tenantId, name) 複合 UNIQUE に置換
DROP INDEX "Category_name_key";
CREATE UNIQUE INDEX "Category_tenantId_name_key" ON "Category"("tenantId", "name");

-- 7) テナントスコープ検索用のインデックス
CREATE INDEX "User_tenantId_idx"             ON "User"("tenantId");
CREATE INDEX "Category_tenantId_idx"         ON "Category"("tenantId");
CREATE INDEX "Ticket_tenantId_idx"           ON "Ticket"("tenantId");
CREATE INDEX "Ticket_tenantId_status_idx"    ON "Ticket"("tenantId", "status");
CREATE INDEX "Ticket_tenantId_createdAt_idx" ON "Ticket"("tenantId", "createdAt" DESC);
CREATE INDEX "FaqCandidate_tenantId_idx"     ON "FaqCandidate"("tenantId");
CREATE INDEX "Notification_tenantId_idx"     ON "Notification"("tenantId");
