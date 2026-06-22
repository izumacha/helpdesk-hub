// SSO 設定リポジトリ (メモリアダプタ) の単体テスト。
// upsert / findByTenant / delete が正しく動き、テナント境界を越えないことを確認する。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。

// Vitest の DSL とフック
import { beforeEach, describe, expect, it } from 'vitest';
// メモリ context (store/repos)
import { createMemoryContext } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用テナント識別子
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// テストごとに作り直す repos
let repos: Repos;

// SSO 設定の入力サンプルを作るヘルパー
function sampleInput(tenantId: string, overrides: Partial<{ enabled: boolean; idpEntityId: string }> = {}) {
  return {
    tenantId, // 所属テナント
    enabled: overrides.enabled ?? true, // 既定は有効
    idpEntityId: overrides.idpEntityId ?? `https://idp.example.com/${tenantId}`, // IdP EntityID
    idpSsoUrl: 'https://idp.example.com/sso', // IdP SSO URL
    idpX509Cert: 'MIIBASEBASE64CERT', // 証明書 (テスト用ダミー)
  };
}

// SSO 設定リポジトリの仕様確認テスト群
describe('SsoConfigRepository (memory)', () => {
  // 各テストの前にメモリ context を作り直す
  beforeEach(() => {
    repos = createMemoryContext().repos;
  });

  // 未設定なら null を返す
  it('未設定のテナントは findByTenant が null を返す', async () => {
    expect(await repos.ssoConfigs.findByTenant(TENANT_A)).toBeNull();
  });

  // upsert が新規作成し、findByTenant で取得できる
  it('upsert で新規作成し findByTenant で取得できる', async () => {
    // 新規作成する
    const created = await repos.ssoConfigs.upsert(sampleInput(TENANT_A));
    // 作成結果が入力どおりであること
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.enabled).toBe(true);
    expect(created.idpEntityId).toBe(`https://idp.example.com/${TENANT_A}`);
    // 取得しても同じ内容であること
    const found = await repos.ssoConfigs.findByTenant(TENANT_A);
    expect(found?.idpSsoUrl).toBe('https://idp.example.com/sso');
  });

  // 同一テナントへの upsert は新規作成ではなく更新になる (1 テナント 1 設定)
  it('同一テナントへの upsert は更新になる (重複作成しない)', async () => {
    // 1 回目: 有効で作成
    const first = await repos.ssoConfigs.upsert(sampleInput(TENANT_A, { enabled: true }));
    // 2 回目: 無効化 + EntityID 変更で更新
    const second = await repos.ssoConfigs.upsert(
      sampleInput(TENANT_A, { enabled: false, idpEntityId: 'https://new-idp.example.com' }),
    );
    // ID は維持され (同一レコードの更新)、値だけ変わる
    expect(second.id).toBe(first.id);
    expect(second.enabled).toBe(false);
    expect(second.idpEntityId).toBe('https://new-idp.example.com');
    // 取得結果も更新後の値
    const found = await repos.ssoConfigs.findByTenant(TENANT_A);
    expect(found?.enabled).toBe(false);
  });

  // delete で設定が消える
  it('delete で設定を削除できる', async () => {
    // 作成してから削除する
    await repos.ssoConfigs.upsert(sampleInput(TENANT_A));
    await repos.ssoConfigs.delete(TENANT_A);
    // 削除後は null
    expect(await repos.ssoConfigs.findByTenant(TENANT_A)).toBeNull();
  });

  // クロステナント分離: テナント A の設定はテナント B から見えない
  it('テナント A の設定はテナント B から取得できない (クロステナント分離)', async () => {
    // A にだけ設定を作る
    await repos.ssoConfigs.upsert(sampleInput(TENANT_A));
    // B からは取得できない
    expect(await repos.ssoConfigs.findByTenant(TENANT_B)).toBeNull();
    // B の delete は A に影響しない
    await repos.ssoConfigs.delete(TENANT_B);
    expect(await repos.ssoConfigs.findByTenant(TENANT_A)).not.toBeNull();
  });
});
