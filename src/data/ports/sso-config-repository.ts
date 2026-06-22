// Phase 4 Enterprise: SAML SSO 設定リポジトリの契約 (port)
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」

// SSO 設定ドメイン型
import type { TenantSsoConfig } from '@/domain/types';

// SSO 設定リポジトリの契約 (port)。1 テナント 1 設定をテナントスコープで操作する
export interface SsoConfigRepository {
  // テナントの SSO 設定を取得する (未設定なら null)
  findByTenant(tenantId: string): Promise<TenantSsoConfig | null>;
  // SSO 設定を作成または更新する (1 テナント 1 設定なので tenantId で upsert)
  upsert(input: {
    tenantId: string; // 所属テナント (セッション由来のみ許可。クロステナント設定防止)
    enabled: boolean; // SSO ログインを有効化するか
    idpEntityId: string; // IdP の EntityID (Issuer)
    idpSsoUrl: string; // IdP の SSO エンドポイント URL
    idpX509Cert: string; // IdP の署名検証用 X.509 証明書
  }): Promise<TenantSsoConfig>;
  // テナントの SSO 設定を削除する (tenantId スコープで他テナントは no-op)
  delete(tenantId: string): Promise<void>;
}
