// createPortalSession (Phase 4 課金: Stripe Customer Portal セッション作成) のテスト。
// Stripe SDK は @/lib/stripe をモックして回避し、権限ゲート・Customer ID 未登録時の
// エラー分岐・正常系の URL 返却を検証する (実際の Stripe API は呼ばない)。
//
// 回帰防止: 兄弟アクション createCheckoutSession には専用テストがある一方、
// createPortalSession にはテストが無く、role ゲートや「未登録テナント」分岐が
// 無検証のまま変更されうる状態だったため追加する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// 権限型 (テストごとにロールを切り替える)
import type { Role } from '@/domain/types';

const TENANT_ID = 'default-tenant';
const USER_ID = 'u-admin-1';

// 各テストで差し替える可変な依存
let store: Store;
let repos: Repos;
// テストごとに切り替えるセッションのロール
let sessionRole: Role = 'admin';
// テストごとに切り替えるセッションの tenantId (未ログイン相当のテストで null にする)
let sessionTenantId: string | null = TENANT_ID;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// セッションはロール・tenantId を可変にしたモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: USER_ID, role: sessionRole, tenantId: sessionTenantId, email: 'admin@example.com' },
  }),
}));

// Stripe SDK 呼び出しをモックする。billingPortal.sessions.create に渡された引数を記録し、
// stripeApiState.shouldThrow を true にすると Stripe API 障害を模擬できるようにする
const { capturedCreateArgs, stripeApiState } = vi.hoisted(() => ({
  capturedCreateArgs: { current: null as Record<string, unknown> | null },
  stripeApiState: { shouldThrow: false },
}));
vi.mock('@/lib/stripe', () => ({
  getStripeClient: () => ({
    billingPortal: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          // Stripe API 障害を模擬するテスト用フラグ (内部詳細を返さないことを検証するため)
          if (stripeApiState.shouldThrow) {
            throw new Error('Stripe API がダウンしています (内部詳細)');
          }
          // 渡されたパラメータを記録する
          capturedCreateArgs.current = args;
          // Stripe Customer Portal の戻り値を模したダミー URL を返す
          return { url: 'https://billing.stripe.com/test-portal-session' };
        },
      },
    },
  }),
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadAction() {
  const mod = await import('@/features/settings/actions/create-portal-session');
  return mod.createPortalSession;
}

// テナントを指定の stripeCustomerId でシードする
function seedTenant(stripeCustomerId: string | null) {
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: stripeCustomerId ? 'standard' : 'free',
    stripeCustomerId,
    stripeSubscriptionId: stripeCustomerId ? 'sub_test123' : null,
    stripeSubscriptionStatus: stripeCustomerId ? 'active' : null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
}

// テストごとにクリーンな状態にする
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  capturedCreateArgs.current = null;
  stripeApiState.shouldThrow = false;
  sessionRole = 'admin';
  sessionTenantId = TENANT_ID;
});

describe('createPortalSession', () => {
  // 正常系: Stripe Customer ID を持つテナントならポータル URL を返す
  it('stripeCustomerId を Customer Portal に渡し URL を返す', async () => {
    seedTenant('cus_test123');
    const createPortalSession = await loadAction();
    const result = await createPortalSession();

    expect(result.url).toBe('https://billing.stripe.com/test-portal-session');
    expect(result.error).toBeUndefined();
    // テナントの Stripe Customer ID がそのまま渡っていること
    expect(capturedCreateArgs.current?.customer).toBe('cus_test123');
  });

  // 異常系: stripeCustomerId が無い (有料プラン未登録) テナントはポータルを開けない
  it('stripeCustomerId が無い場合はエラーを返す', async () => {
    seedTenant(null);
    const createPortalSession = await loadAction();
    const result = await createPortalSession();

    expect(result.url).toBeUndefined();
    expect(result.error).toBe('課金情報が見つかりません。まず有料プランにご登録ください。');
  });

  // 権限ゲート: admin 以外 (agent) は拒否される (課金操作は管理者専用 §9)
  it('agent ロールは拒否される', async () => {
    seedTenant('cus_test123');
    sessionRole = 'agent';
    const createPortalSession = await loadAction();
    const result = await createPortalSession();

    expect(result.url).toBeUndefined();
    expect(result.error).toBe('この操作は管理者のみ実行できます');
  });

  // 権限ゲート: 未ログイン (tenantId 不在) は拒否される
  it('tenantId が無いセッションは拒否される', async () => {
    seedTenant('cus_test123');
    sessionTenantId = null;
    const createPortalSession = await loadAction();
    const result = await createPortalSession();

    expect(result.url).toBeUndefined();
    expect(result.error).toBe('認証が必要です');
  });

  // 異常系: Stripe API がエラーを返した場合は内部詳細を返さず汎用メッセージにする (§9)
  it('Stripe API エラー時は汎用メッセージを返す', async () => {
    seedTenant('cus_test123');
    // このテストだけ Stripe API 障害を模擬する
    stripeApiState.shouldThrow = true;
    const createPortalSession = await loadAction();
    const result = await createPortalSession();

    expect(result.url).toBeUndefined();
    // 内部詳細 (Stripe のエラーメッセージ) を含まない汎用メッセージであること
    expect(result.error).toBe(
      'Stripe ポータルの作成に失敗しました。しばらく後にもう一度お試しください。',
    );
  });
});
