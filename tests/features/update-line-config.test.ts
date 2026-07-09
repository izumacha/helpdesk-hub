// updateLineConfig (Server Action) のテスト。
// 書き込み専用フィールド (channelSecret / channelAccessToken) が §9 の方針どおり
// 空欄送信で既存値を維持し、画面へ現在値を返さないことを中心に検証する。

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
const BOT_USER_ID_A = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOT_USER_ID_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証は固定セッション (admin) を返すモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID },
  }),
}));

// next/cache の副作用 (revalidatePath) はテストでは不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// FormData を組み立てるヘルパー (空欄で送りたいフィールドは省略可能にする)
function makeForm(input: {
  channelSecret?: string;
  channelAccessToken?: string;
  botUserId?: string;
}): FormData {
  const fd = new FormData();
  fd.set('channelSecret', input.channelSecret ?? '');
  fd.set('channelAccessToken', input.channelAccessToken ?? '');
  fd.set('botUserId', input.botUserId ?? '');
  return fd;
}

// 指定プランのテナントをシードする (Pro/Enterprise のみ LINE 連携可)
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

describe('updateLineConfig', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    __resetRateLimits();
  });

  // Standard プランでは LINE 連携自体が使えない (§6.1 料金プラン)
  it('Standard プランでは保存が拒否される', async () => {
    seedTenant('standard');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    const result = await updateLineConfig(
      {},
      makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: BOT_USER_ID_A }),
    );
    expect(result.error).toBe('LINE 連携は Pro / Enterprise プランでのみ利用できます。');
    expect(store.lineConfigs.size).toBe(0);
  });

  // 新規作成時は channelSecret / channelAccessToken が空だとエラーになる (書き込み専用フィールドの必須化)
  it('新規作成時に channelSecret が空だとエラーになる', async () => {
    seedTenant('pro');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    const result = await updateLineConfig(
      {},
      makeForm({ channelAccessToken: 't1', botUserId: BOT_USER_ID_A }),
    );
    expect(result.error).toBe('チャネルシークレットは必須です');
    expect(store.lineConfigs.size).toBe(0);
  });

  // 新規作成は全フィールドを入力すれば成功する
  it('新規作成は全フィールド入力で成功する', async () => {
    seedTenant('pro');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    const result = await updateLineConfig(
      {},
      makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: BOT_USER_ID_A }),
    );
    expect(result.success).toBe(true);
    const saved = await repos.lineConfigs.findByTenant(TENANT_ID);
    expect(saved?.channelSecret).toBe('s1');
    expect(saved?.channelAccessToken).toBe('t1');
    expect(saved?.botUserId).toBe(BOT_USER_ID_A);
    // §4.2 フォローアップ: 監査ログに記録されること
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('line_config_update');
  });

  // 書き込み専用フィールドの中核仕様: 既存設定がある状態で channelSecret / channelAccessToken を
  // 空欄のまま送信すると、既存の値を上書きせずそのまま維持する (§9: 秘密情報を画面に出さない設計)
  it('空欄で送信すると既存の channelSecret / channelAccessToken を維持する', async () => {
    seedTenant('pro');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    // 1 回目: 通常どおり全項目を入力して作成
    await updateLineConfig(
      {},
      makeForm({
        channelSecret: 'original-secret',
        channelAccessToken: 'original-token',
        botUserId: BOT_USER_ID_A,
      }),
    );
    // 2 回目: botUserId だけ変更し、シークレット/トークンは空欄のまま送信
    const result = await updateLineConfig({}, makeForm({ botUserId: BOT_USER_ID_B }));
    expect(result.success).toBe(true);
    const saved = await repos.lineConfigs.findByTenant(TENANT_ID);
    // シークレット・トークンは初回設定時の値のまま (空文字で上書きされていない)
    expect(saved?.channelSecret).toBe('original-secret');
    expect(saved?.channelAccessToken).toBe('original-token');
    // botUserId だけ更新されている
    expect(saved?.botUserId).toBe(BOT_USER_ID_B);
  });

  // botUserId の形式検証 (destination との一致に使うため 'U' + 32桁 hex 以外は拒否する)
  it('botUserId の形式が不正だとエラーになる', async () => {
    seedTenant('pro');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    const result = await updateLineConfig(
      {},
      makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: 'not-a-valid-id' }),
    );
    expect(result.error).toBe('Bot User ID の形式が正しくありません ("U" + 32桁の16進数)');
  });

  // 他テナントが既に使用中の botUserId は一意制約違反として拒否される
  it('他テナントが使用中の botUserId は拒否される', async () => {
    seedTenant('pro');
    // 別テナントが同じ botUserId を既に登録済み
    await repos.lineConfigs.upsert({
      tenantId: 'other-tenant',
      channelSecret: 's-other',
      channelAccessToken: 't-other',
      botUserId: BOT_USER_ID_A,
    });
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    const result = await updateLineConfig(
      {},
      makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: BOT_USER_ID_A }),
    );
    expect(result.error).toBe('この Bot User ID は既に別のテナントで登録されています');
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される (create/update/delete-location.ts と
  // 同じ「テナント単位で共有」の方針。update-sso-config.test.ts も参照)
  it('60秒あたり10回を超える連打は拒否される', async () => {
    seedTenant('pro');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    for (let i = 0; i < 10; i++) {
      const result = await updateLineConfig(
        {},
        makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: BOT_USER_ID_A }),
      );
      expect(result.error).toBeUndefined();
    }
    const result = await updateLineConfig(
      {},
      makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: BOT_USER_ID_A }),
    );
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
