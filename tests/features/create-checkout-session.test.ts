// createCheckoutSession (Phase 4 課金: Stripe Checkout セッション作成) のテスト。
// Stripe SDK は @/lib/stripe をモックして回避し、渡された作成パラメータを検証する
// (実際の Stripe API は呼ばない)。
//
// 回帰防止 (§8 リスク対策「IT導入補助金の審査要件」): 日本のインボイス制度対応として
// Stripe Checkout に tax_id_collection を有効化したが、実装時の単純な削除・タイポで
// 意図せず消えてしまう可能性があるため、実際に渡るパラメータを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束 / UnitOfWork の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';

// 各テスト前に書き換える依存。Action import 前に getter で参照させる
let store: Store;
let repos: Repos;
let uow: UnitOfWork;

// @/data を差し替え。getter で参照することで、テスト中の上書きが反映される
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// セッションは admin 固定 (課金操作は admin のみ許可されるため)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: 'admin-1', role: 'admin', tenantId: 'default-tenant', email: 'admin@example.com' },
  }),
}));

// Stripe SDK 呼び出しをモックする。checkout.sessions.create に渡された引数を
// capturedCreateArgs に記録し、テストからパラメータの中身を検証できるようにする
const { capturedCreateArgs } = vi.hoisted(() => ({
  capturedCreateArgs: { current: null as Record<string, unknown> | null },
}));
vi.mock('@/lib/stripe', () => ({
  getStripeClient: () => ({
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          // 渡されたパラメータを記録する
          capturedCreateArgs.current = args;
          // Stripe Checkout の戻り値を模したダミー URL を返す
          return { url: 'https://checkout.stripe.com/test-session' };
        },
      },
    },
  }),
  STRIPE_PRICE_IDS: { standard: 'price_standard_test', pro: 'price_pro_test' },
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadAction() {
  const mod = await import('@/features/settings/actions/create-checkout-session');
  return mod.createCheckoutSession;
}

// テストごとにクリーンな状態にする
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  capturedCreateArgs.current = null;
  // 呼び出し元テナントを 1 つ用意しておく
  store.tenants.set('default-tenant', {
    id: 'default-tenant',
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
});

describe('createCheckoutSession', () => {
  // 回帰防止: インボイス制度対応 (tax_id_collection) が Checkout セッション作成時に
  // 有効化されていること
  it('tax_id_collection を有効にして Checkout セッションを作成する', async () => {
    const createCheckoutSession = await loadAction();
    const result = await createCheckoutSession('standard');

    // 正常にセッション URL が返る
    expect(result.url).toBe('https://checkout.stripe.com/test-session');
    // Stripe へ渡したパラメータに tax_id_collection.enabled が含まれる
    expect(capturedCreateArgs.current?.tax_id_collection).toEqual({ enabled: true });
  });

  // 正常系: 選択したプランの Price ID が line_items に渡ること
  it('選択したプランの Price ID を line_items に渡す', async () => {
    const createCheckoutSession = await loadAction();
    await createCheckoutSession('pro');

    expect(capturedCreateArgs.current?.line_items).toEqual([
      { price: 'price_pro_test', quantity: 1 },
    ]);
  });
});
