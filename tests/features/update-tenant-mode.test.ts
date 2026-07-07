// updateTenantMode (Server Action) のテスト。
// Lite/Pro モード切替と、Pro モードのプランゲート (isProModeAllowed) をメモリアダプタで検証する。

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
const ADMIN_ID = 'u-admin-1';

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

// FormData を組み立てるヘルパー
function makeForm(mode: string): FormData {
  const fd = new FormData();
  fd.set('mode', mode);
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

describe('updateTenantMode', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    __resetRateLimits();
  });

  // Lite への切替はどのプランでも常に許可する
  it('Free プランでも Lite への切替は成功する', async () => {
    seedTenant('free');
    const { updateTenantMode } = await import('@/features/settings/actions/update-tenant-mode');
    await updateTenantMode(makeForm('lite'));
    expect(store.tenants.get(TENANT_ID)?.mode).toBe('lite');
  });

  // Pro モードへの切替は Pro / Enterprise プランのみ許可する (§6.1 料金プラン)
  it('Free プランでは Pro への切替が拒否される', async () => {
    seedTenant('free');
    const { updateTenantMode } = await import('@/features/settings/actions/update-tenant-mode');
    await expect(updateTenantMode(makeForm('pro'))).rejects.toThrow(
      'Pro モードは Pro / Enterprise プランでご利用いただけます。',
    );
    // 拒否された場合はモードが変更されていないこと
    expect(store.tenants.get(TENANT_ID)?.mode).toBe('lite');
  });

  // Standard プランでも Pro モードは使えない (Standard は Lite フルのみ)
  it('Standard プランでも Pro への切替が拒否される', async () => {
    seedTenant('standard');
    const { updateTenantMode } = await import('@/features/settings/actions/update-tenant-mode');
    await expect(updateTenantMode(makeForm('pro'))).rejects.toThrow(
      'Pro モードは Pro / Enterprise プランでご利用いただけます。',
    );
  });

  // Pro プランなら Pro への切替が成功する
  it('Pro プランでは Pro への切替が成功する', async () => {
    seedTenant('pro');
    const { updateTenantMode } = await import('@/features/settings/actions/update-tenant-mode');
    await updateTenantMode(makeForm('pro'));
    expect(store.tenants.get(TENANT_ID)?.mode).toBe('pro');
  });

  // Enterprise プランでも Pro への切替が成功する
  it('Enterprise プランでは Pro への切替が成功する', async () => {
    seedTenant('enterprise');
    const { updateTenantMode } = await import('@/features/settings/actions/update-tenant-mode');
    await updateTenantMode(makeForm('pro'));
    expect(store.tenants.get(TENANT_ID)?.mode).toBe('pro');
  });
});
