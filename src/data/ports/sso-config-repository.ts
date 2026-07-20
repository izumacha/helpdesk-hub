// Phase 4 Enterprise: SAML SSO 設定リポジトリの契約 (port)
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」

// SSO 設定ドメイン型
import type { TenantSsoConfig } from '@/domain/types';

// SSO 設定リポジトリの契約 (port)。1 テナント 1 設定をテナントスコープで操作する
export interface SsoConfigRepository {
  // テナントの SSO 設定を取得する (未設定なら null)
  findByTenant(tenantId: string): Promise<TenantSsoConfig | null>;
  // SSO 設定を作成または更新する (1 テナント 1 設定なので tenantId で upsert)。
  // フォローアップ (監査で発見したギャップ): 設定フォームは常に現在値を全項目 defaultValue で
  // 事前入力して丸ごと再送信する構成のため (channelSecret 等を空欄=維持で扱う LINE 連携設定とは
  // 異なり、この画面には「変更しない」フィールドという概念が無い)、読み取り→無条件書き込みの間に
  // 他の管理者が並行更新すると check-then-act (TOCTOU) で後勝ち上書きが起きる。特に IdP 証明書の
  // ローテーション直後に古いフォームが送信されると、認証の信頼アンカーが黙って古い証明書へ
  // 巻き戻ってしまう (update-line-config.ts の LineConfigRepository.upsert と同じ穴)。
  upsert(input: {
    tenantId: string; // 所属テナント (セッション由来のみ許可。クロステナント設定防止)
    enabled: boolean; // SSO ログインを有効化するか
    idpEntityId: string; // IdP の EntityID (Issuer)
    idpSsoUrl: string; // IdP の SSO エンドポイント URL
    idpX509Cert: string; // IdP の署名検証用 X.509 証明書
    // CAS: 読み取り時点の既存設定値。渡された場合、書き込み直前の現在値がこれと一致する
    // ときだけ更新する。未指定 (新規作成、または呼び出し側が競合検知を必要としない場合) なら
    // 従来どおり無条件 upsert する (LineConfigRepository.upsert と同じ契約)。
    expected?: {
      enabled: boolean;
      idpEntityId: string;
      idpSsoUrl: string;
      idpX509Cert: string;
    };
  }): Promise<TenantSsoConfig | null>; // null は競合 (書き込み直前に他の更新が割り込んだ) を意味する
  // テナントの SSO 設定を削除する (tenantId スコープで他テナントは no-op)
  delete(tenantId: string): Promise<void>;
}
