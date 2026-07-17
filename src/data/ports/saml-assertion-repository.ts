// SAML アサーションのリプレイ防止記録リポジトリの契約 (port)。
//
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」フォローアップ。
// ACS (/api/auth/sso/<tenantId>/acs) は署名・Issuer・Audience・期限を検証するが、有効期限内の
// 同一 SAMLResponse を攻撃者が複数回 POST しても検証自体は毎回成功してしまう (リプレイ攻撃)。
// このリポジトリは「(tenantId, assertionId) を初めて見た」場合だけ記録して true を返し、
// 既に記録済み (= 同じアサーションの再利用) なら false を返す。呼び出し側 (ACS ルート) は
// false ならログインを拒否する。
//
// セキュリティ不変条件 (§9): 判定・記録は必ず認証済み文脈で得た `tenantId` でスコープすること。
export interface SamlAssertionRepository {
  /**
   * (tenantId, assertionId) が初回利用なら記録して true を返す。
   * 既に記録済み (リプレイ) なら何も変更せず false を返す。
   * 同時に同じアサーションで 2 リクエストが来ても、一意制約により片方だけが true になる
   * (アダプタ側で一意制約違反を検出してアトミックに判定する)。
   */
  recordIfNew(input: { tenantId: string; assertionId: string }): Promise<boolean>;
}
