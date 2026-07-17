-- SAML SSO のリプレイ防止 (docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」フォローアップ):
-- ACS は署名・Issuer・Audience・期限を検証するが、有効期限内の同一 SAMLResponse を攻撃者が
-- 複数回 POST しても検証は毎回成功してしまう (リプレイ攻撃)。SAML アサーション ID を使用済み
-- として記録し、2 回目以降の同一アサーションを拒否する。
-- @@unique([tenantId, assertionId]) でテナント内一意にし、複数テナントの IdP 間でアサーション ID
-- が衝突しても互いの利用を誤って拒否しないようにする。

CREATE TABLE "SamlAssertionRef" (
    "id" TEXT NOT NULL,
    "assertionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "SamlAssertionRef_pkey" PRIMARY KEY ("id")
);

-- テナント内でアサーション ID は一意 (2 回目以降の利用 = リプレイを検知)
CREATE UNIQUE INDEX "SamlAssertionRef_tenantId_assertionId_key" ON "SamlAssertionRef"("tenantId", "assertionId");

-- テナントスコープ検索を高速化するインデックス
CREATE INDEX "SamlAssertionRef_tenantId_idx" ON "SamlAssertionRef"("tenantId");

-- 所属テナントへの外部キー (テナント削除で記録も連鎖削除)
ALTER TABLE "SamlAssertionRef"
    ADD CONSTRAINT "SamlAssertionRef_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
