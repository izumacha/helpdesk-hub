-- Phase 4 Enterprise: テナント単位の SAML SSO 設定テーブルを追加する。
-- docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
-- アプリを SAML の Service Provider (SP) として動かすために必要な IdP 情報を保持する。
-- Enterprise プランのみが構成・利用できる (サーバー側 plan-guard で強制)。

-- SSO 設定テーブル本体
CREATE TABLE "TenantSsoConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "idpEntityId" TEXT NOT NULL,
    "idpSsoUrl" TEXT NOT NULL,
    "idpX509Cert" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSsoConfig_pkey" PRIMARY KEY ("id")
);

-- 1 テナント 1 設定 (1:1) を担保する一意インデックス
CREATE UNIQUE INDEX "TenantSsoConfig_tenantId_key" ON "TenantSsoConfig"("tenantId");

-- テナント削除時に SSO 設定も連鎖削除する外部キー制約
ALTER TABLE "TenantSsoConfig"
    ADD CONSTRAINT "TenantSsoConfig_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
