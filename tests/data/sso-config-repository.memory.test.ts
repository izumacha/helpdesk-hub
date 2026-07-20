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
function sampleInput(
  tenantId: string,
  overrides: Partial<{ enabled: boolean; idpEntityId: string }> = {},
) {
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
    // 作成結果が入力どおりであること (expected 未指定の無条件 upsert なので null にはならない)
    expect(created?.tenantId).toBe(TENANT_A);
    expect(created?.enabled).toBe(true);
    expect(created?.idpEntityId).toBe(`https://idp.example.com/${TENANT_A}`);
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
    // ID は維持され (同一レコードの更新)、値だけ変わる (どちらも expected 未指定の無条件 upsert)
    expect(second?.id).toBe(first?.id);
    expect(second?.enabled).toBe(false);
    expect(second?.idpEntityId).toBe('https://new-idp.example.com');
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

  // 監査で発見したギャップ対応: expected (CAS) 省略時は従来どおり無条件更新、
  // expected 指定時は読み取り時点の値と一致するときだけ更新することを検証する
  // (LineConfigRepository.upsert の同名テストと同じ設計)
  it('expectedが現在値と一致しない場合は更新せずnullを返す', async () => {
    // 現在値を作成する
    const current = await repos.ssoConfigs.upsert(sampleInput(TENANT_A, { enabled: true }));
    // 誤った (古い) expected を渡して更新を試みる
    const result = await repos.ssoConfigs.upsert({
      ...sampleInput(TENANT_A, { enabled: false }),
      expected: {
        enabled: false, // 実際の現在値 (true) と食い違う誤った期待値
        idpEntityId: current!.idpEntityId,
        idpSsoUrl: current!.idpSsoUrl,
        idpX509Cert: current!.idpX509Cert,
      },
    });
    // 競合とみなされ null を返す
    expect(result).toBeNull();
    // 実際の値は上書きされていない
    const found = await repos.ssoConfigs.findByTenant(TENANT_A);
    expect(found?.enabled).toBe(true);
  });

  // expected が現在値と一致すれば更新される
  it('expectedが現在値と一致すれば更新できる', async () => {
    // 現在値を作成する
    const current = await repos.ssoConfigs.upsert(sampleInput(TENANT_A, { enabled: true }));
    // 正しい expected (現在値そのもの) を渡して更新する
    const result = await repos.ssoConfigs.upsert({
      ...sampleInput(TENANT_A, { enabled: false }),
      expected: {
        enabled: current!.enabled,
        idpEntityId: current!.idpEntityId,
        idpSsoUrl: current!.idpSsoUrl,
        idpX509Cert: current!.idpX509Cert,
      },
    });
    // 更新後の値が返る
    expect(result?.enabled).toBe(false);
    const found = await repos.ssoConfigs.findByTenant(TENANT_A);
    expect(found?.enabled).toBe(false);
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
