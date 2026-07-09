// updateSsoConfig (Server Action) のテスト。
// プランゲート・入力検証 (URL/証明書)・レート制限をメモリアダプタで検証する。
// これまでこのアクションにテストが存在しなかったギャップを埋める
// (監査で発見。delete-sso-config.test.ts はテスト済みだったが update 側は未検証だった)。

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// 課金プランの型 (フィクスチャ切替に使う)
import type { SubscriptionPlan } from '@/domain/types';
// レート制限バケットをテスト間で初期化するヘルパー
import { __resetRateLimits } from '@/lib/rate-limit';

const TENANT_ID = 'tenant-1';
const ADMIN_ID = 'u-admin-1';

// テスト用の妥当な自己署名証明書 (X509Certificate でパース可能な実在の PEM。
// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 で生成した使い捨て証明書)。
// この証明書は base64 本体の長さがちょうど 512 文字 (64 の倍数) になっており、
// validateCert の「64 文字ごとに改行を入れる」ラップ処理が末尾に余分な空行を作ってしまう
// バグ (本 PR で修正) の回帰テストを兼ねる。長さが 64 の倍数でない証明書だとこのバグを
// 再現しないため、意図的にこの条件を満たす証明書を選んでいる
const VALID_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBejCCASGgAwIBAgIUTU0oqjbacH2Bdi53MhfEyhAUx94wCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIVGVzdCBJZFAwHhcNMjYwNzA5MDk1MzQyWhcNMzYwNzA2MDk1
MzQyWjATMREwDwYDVQQDDAhUZXN0IElkUDBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABLYCfBxmzqJwohrT33aa8LoP5ocduX1u8BxvglgdZlSifPmU115wmHH3WjpQ
Az+Mc0D17StwBdvddsHk4cBuj82jUzBRMB0GA1UdDgQWBBTDj3SgGLTG5xUTmI5Y
QF8cFaXunjAfBgNVHSMEGDAWgBTDj3SgGLTG5xUTmI5YQF8cFaXunjAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIGNBELNismu2/iXXJpiLbjwNfAdR
yGVurItfB5ICiWtfAiAJB2Sy0no9JH1syJpJAR5/13FZ8wuGSgJV1GxUF4C9yQ==
-----END CERTIFICATE-----`;

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;
// 認証モックが返すセッション (テストごとに差し替える)
let sessionUser: { id: string; role: string; tenantId: string } | null;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証はテストごとに差し替え可能なセッションを返すモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => (sessionUser ? { user: sessionUser } : null),
}));

// next/cache の副作用 (revalidatePath) はテストでは不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// FormData を組み立てるヘルパー
function makeForm(input: {
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpX509Cert?: string;
  enabled?: boolean;
}): FormData {
  const fd = new FormData();
  fd.set('idpEntityId', input.idpEntityId ?? 'https://idp.example.com/entity');
  fd.set('idpSsoUrl', input.idpSsoUrl ?? 'https://idp.example.com/sso');
  fd.set('idpX509Cert', input.idpX509Cert ?? VALID_CERT_PEM);
  if (input.enabled) fd.set('enabled', 'on');
  return fd;
}

// 指定プランのテナントをシードする
function seedTenant(plan: SubscriptionPlan) {
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'テスト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
}

describe('updateSsoConfig', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionUser = { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID };
    __resetRateLimits();
  });

  // Pro プランでは SSO 自体が使えない (§6.1 料金プラン、Enterprise 限定)
  it('Pro プランでは保存が拒否される', async () => {
    seedTenant('pro');
    const { updateSsoConfig } = await import('@/features/settings/actions/update-sso-config');
    const result = await updateSsoConfig({}, makeForm({}));
    expect(result.error).toEqual(expect.any(String));
    expect(await repos.ssoConfigs.findByTenant(TENANT_ID)).toBeNull();
  });

  // admin 以外は保存できない
  it('agent ロールは拒否される', async () => {
    seedTenant('enterprise');
    sessionUser = { id: 'u-agent-1', role: 'agent', tenantId: TENANT_ID };
    const { updateSsoConfig } = await import('@/features/settings/actions/update-sso-config');
    const result = await updateSsoConfig({}, makeForm({}));
    expect(result.error).toBe('この操作は管理者のみ実行できます');
  });

  // 妥当な入力なら Enterprise プランで保存できる
  it('Enterprise プランで妥当な入力なら保存できる', async () => {
    seedTenant('enterprise');
    const { updateSsoConfig } = await import('@/features/settings/actions/update-sso-config');
    const result = await updateSsoConfig({}, makeForm({ enabled: true }));
    expect(result.success).toBe(true);
    const saved = await repos.ssoConfigs.findByTenant(TENANT_ID);
    expect(saved?.idpEntityId).toBe('https://idp.example.com/entity');
    expect(saved?.enabled).toBe(true);
    // §4.2 フォローアップ: 監査ログに記録されること
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('sso_config_update');
  });

  // https 以外の SSO URL は拒否される (ブラウザのリダイレクト先になるため)
  it('httpsで始まらないSSO URLは拒否される', async () => {
    seedTenant('enterprise');
    const { updateSsoConfig } = await import('@/features/settings/actions/update-sso-config');
    const result = await updateSsoConfig({}, makeForm({ idpSsoUrl: 'http://idp.example.com/sso' }));
    expect(result.error).toBe('IdP の SSO URL は https:// で始まる必要があります');
  });

  // パースできない証明書は拒否される
  it('不正な証明書は拒否される', async () => {
    seedTenant('enterprise');
    const { updateSsoConfig } = await import('@/features/settings/actions/update-sso-config');
    const result = await updateSsoConfig({}, makeForm({ idpX509Cert: 'not-a-certificate' }));
    expect(result.error).toEqual(expect.any(String));
    expect(await repos.ssoConfigs.findByTenant(TENANT_ID)).toBeNull();
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される (delete-sso-config.ts と共有)
  it('60秒あたり10回を超える連打は拒否される', async () => {
    seedTenant('enterprise');
    const { updateSsoConfig } = await import('@/features/settings/actions/update-sso-config');
    for (let i = 0; i < 10; i++) {
      const result = await updateSsoConfig({}, makeForm({}));
      expect(result.error).toBeUndefined();
    }
    const result = await updateSsoConfig({}, makeForm({}));
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
