// deleteLineConfig (Server Action) のテスト。
// プラン降格後 (Standard 以下) でも、既存の LINE 連携設定は削除できることを中心に検証する
// (assertLineConfigOwner はプラン不問。line-config-context.ts 参照)。

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
const BOT_USER_ID = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

// FormData を組み立てるヘルパー (updateLineConfig との共有レート制限テストで使う)
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

describe('deleteLineConfig', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionUser = { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID };
    __resetRateLimits();
  });

  // 本 PR の主眼: Pro 在籍中に作った設定を Standard へ降格した後でも削除できる
  // (assertLineConfigAdmin を使った旧実装では、プラン不許可を理由に削除自体が拒否されていた)
  it('プラン降格後 (Standard) でも既存の LINE 連携設定を削除できる', async () => {
    seedTenant('pro');
    await repos.lineConfigs.upsert({
      tenantId: TENANT_ID,
      channelSecret: 's1',
      channelAccessToken: 't1',
      botUserId: BOT_USER_ID,
    });
    // Standard へ降格 (LINE 連携は Pro/Enterprise 限定)
    seedTenant('standard');

    const { deleteLineConfig } = await import('@/features/settings/actions/delete-line-config');
    const result = await deleteLineConfig({}, new FormData());

    expect(result.success).toBe(true);
    expect(await repos.lineConfigs.findByTenant(TENANT_ID)).toBeNull();
  });

  // admin 以外は削除できない (プラン不問ゲートでも RBAC は維持する)
  it('admin 以外は削除できない', async () => {
    seedTenant('pro');
    await repos.lineConfigs.upsert({
      tenantId: TENANT_ID,
      channelSecret: 's1',
      channelAccessToken: 't1',
      botUserId: BOT_USER_ID,
    });
    sessionUser = { id: 'u-agent-1', role: 'agent', tenantId: TENANT_ID };

    const { deleteLineConfig } = await import('@/features/settings/actions/delete-line-config');
    const result = await deleteLineConfig({}, new FormData());

    expect(result.error).toBe('この操作は管理者のみ実行できます');
    expect(await repos.lineConfigs.findByTenant(TENANT_ID)).not.toBeNull();
  });

  // 未ログインは拒否される
  it('未ログインでは削除できない', async () => {
    seedTenant('pro');
    sessionUser = null;

    const { deleteLineConfig } = await import('@/features/settings/actions/delete-line-config');
    const result = await deleteLineConfig({}, new FormData());

    expect(result.error).toBe('認証が必要です');
  });

  // レート制限は update/delete-line-config でテナント単位に共有する (update だけで
  // 上限を使い切っても delete が同じテナントでは拒否されることを確認する)
  it('updateとレート制限を共有する', async () => {
    seedTenant('pro');
    const { updateLineConfig } = await import('@/features/settings/actions/update-line-config');
    const { deleteLineConfig } = await import('@/features/settings/actions/delete-line-config');

    // update だけで上限 (10回) を使い切る
    for (let i = 0; i < 10; i++) {
      const result = await updateLineConfig(
        {},
        makeForm({ channelSecret: 's1', channelAccessToken: 't1', botUserId: BOT_USER_ID }),
      );
      expect(result.error).toBeUndefined();
    }

    // 同じテナントの delete も共有の上限に達しているため拒否される
    const deleteResult = await deleteLineConfig({}, new FormData());
    expect(deleteResult.error).toEqual(expect.any(String));
    expect(deleteResult.success).toBeUndefined();
  });
});
