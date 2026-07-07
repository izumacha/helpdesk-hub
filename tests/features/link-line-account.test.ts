// generateLineLinkCode_action (Server Action) のテスト。
// LINE 連携コード発行のプランゲート (isLineIntegrationAllowed) をメモリアダプタで検証する。

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';
// 課金プランの型 (フィクスチャ切替に使う)
import type { SubscriptionPlan } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const MEMBER_ID = 'u-member-1';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証は固定セッション (requester でも自己サービスとして許可) を返すモックに置換
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: MEMBER_ID, role: 'requester', tenantId: TENANT_ID },
  }),
}));

// next/cache の副作用 (revalidatePath) はテストでは不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// 指定プランのテナント + 対象メンバーをシードする
function seed(plan: SubscriptionPlan) {
  const now = new Date();
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
    createdAt: now,
  });
  store.users.set(MEMBER_ID, {
    id: MEMBER_ID,
    email: 'member@example.com',
    name: '依頼 花子',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT_ID,
    createdAt: now,
    updatedAt: now,
  });
}

describe('generateLineLinkCode_action', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    __resetRateLimits();
  });

  // LINE 連携は Pro / Enterprise プランのみ (§6.1 料金プラン)。Free では拒否される
  it('Free プランでは拒否される', async () => {
    seed('free');
    const { generateLineLinkCode_action } =
      await import('@/features/settings/actions/link-line-account');
    await expect(generateLineLinkCode_action()).rejects.toThrow(
      'LINE 連携は Pro / Enterprise プランでご利用いただけます。',
    );
    // 拒否された場合はコードが発行されていないこと
    expect(store.users.get(MEMBER_ID)?.lineLinkCodeHash).toBeFalsy();
  });

  // Standard プランでも拒否される (Standard は Lite フル + メール取り込みまで)
  it('Standard プランでは拒否される', async () => {
    seed('standard');
    const { generateLineLinkCode_action } =
      await import('@/features/settings/actions/link-line-account');
    await expect(generateLineLinkCode_action()).rejects.toThrow(
      'LINE 連携は Pro / Enterprise プランでご利用いただけます。',
    );
  });

  // Pro プランならコードが発行される
  it('Pro プランでは発行に成功する', async () => {
    seed('pro');
    const { generateLineLinkCode_action } =
      await import('@/features/settings/actions/link-line-account');
    const result = await generateLineLinkCode_action();
    // 生コードが返される
    expect(result.code.length).toBeGreaterThan(0);
    // DB にはハッシュが保存されている (生コードそのものではない)
    expect(store.users.get(MEMBER_ID)?.lineLinkCodeHash).toBeTruthy();
  });

  // Enterprise プランでも発行に成功する
  it('Enterprise プランでは発行に成功する', async () => {
    seed('enterprise');
    const { generateLineLinkCode_action } =
      await import('@/features/settings/actions/link-line-account');
    const result = await generateLineLinkCode_action();
    expect(result.code.length).toBeGreaterThan(0);
  });
});
