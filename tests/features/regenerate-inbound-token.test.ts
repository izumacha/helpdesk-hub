// regenerateInboundToken (Server Action) のテスト。
// 未発行テナントへの初回発行、既存テナントでの再発行 (ローテーション)、
// 管理者以外の拒否、レート制限をメモリアダプタで検証する。

// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';
// 権限型
import type { Role } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const DEFAULT_USER_ID = 'u-1';

// 各テストで差し替える可変な依存 (Action import 前に値を入れる)
let store: Store;
let repos: Repos;
// テストごとに切り替えるセッションのロール
let sessionRole: Role = 'admin';
// テストごとに切り替えるセッションのユーザー ID (同一テナント内の別管理者を模す)
let sessionUserId: string = DEFAULT_USER_ID;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証はロール・ユーザー ID を可変にしたモックに置換 (テストごとに切り替える)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: sessionUserId, role: sessionRole, tenantId: TENANT_ID },
  }),
}));

// next/cache の副作用 (revalidatePath) はテストでは不要
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// 指定の inboundToken でテナントをシードする。プランは既定でメール取り込み許可プラン
// (standard) にする (regenerateInboundToken 自体のプランゲートを検証するテストのみ free を渡す)
function seedTenant(
  inboundToken: string | null,
  subscriptionPlan: 'free' | 'standard' = 'standard',
) {
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'テスト組織',
    mode: 'lite',
    industry: null,
    inboundToken,
    slackWebhookUrl: null,
    subscriptionPlan,
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

describe('regenerateInboundToken', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionRole = 'admin';
    sessionUserId = DEFAULT_USER_ID;
    __resetRateLimits();
  });

  // 未発行 (null) のテナントに新しいトークンを発行できる
  it('未発行テナントに新しいトークンを発行できる', async () => {
    seedTenant(null);
    const { regenerateInboundToken } =
      await import('@/features/settings/actions/regenerate-inbound-token');
    await regenerateInboundToken();
    const updated = store.tenants.get(TENANT_ID);
    expect(updated?.inboundToken).toEqual(expect.any(String));
    expect(updated?.inboundToken).not.toBeNull();
  });

  // 既存トークンを新しい値に差し替えられる (漏洩時のローテーション用途)
  it('既存トークンを新しい値に再発行する', async () => {
    seedTenant('old-token-value');
    const { regenerateInboundToken } =
      await import('@/features/settings/actions/regenerate-inbound-token');
    await regenerateInboundToken();
    const updated = store.tenants.get(TENANT_ID);
    expect(updated?.inboundToken).not.toBe('old-token-value');
  });

  // admin 以外 (agent) は拒否される (組織設定は管理者専用 §9)
  it('agent ロールは拒否される', async () => {
    seedTenant(null);
    sessionRole = 'agent';
    const { regenerateInboundToken } =
      await import('@/features/settings/actions/regenerate-inbound-token');
    await expect(regenerateInboundToken()).rejects.toThrow('この操作は管理者のみ実行できます');
    // トークンは発行されないまま
    expect(store.tenants.get(TENANT_ID)?.inboundToken).toBeNull();
  });

  // レート制限: 短時間に連打すると拒否される (60 秒あたり 3 回まで)
  it('60秒あたり3回を超える連打は拒否される', async () => {
    seedTenant(null);
    const { regenerateInboundToken } =
      await import('@/features/settings/actions/regenerate-inbound-token');
    await regenerateInboundToken();
    await regenerateInboundToken();
    await regenerateInboundToken();
    await expect(regenerateInboundToken()).rejects.toThrow();
  });

  // レート制限はテナント単位でキーを切る (同一テナントの複数管理者が個別の枠を
  // 持つと合計の再発行回数が管理者数倍になり、制限の意図を損なうため)
  it('同一テナントの別ユーザーとも上限を共有する', async () => {
    seedTenant(null);
    const { regenerateInboundToken } =
      await import('@/features/settings/actions/regenerate-inbound-token');
    // ユーザー u-1 として上限まで発行する
    await regenerateInboundToken();
    await regenerateInboundToken();
    await regenerateInboundToken();
    // 同一テナントの別ユーザーに切り替えても、テナント単位の上限を共有するため拒否される
    sessionUserId = 'u-2';
    await expect(regenerateInboundToken()).rejects.toThrow();
  });

  // プランゲート: メール取り込み非許可プラン (Free) ではサーバー側でも拒否される
  // (設定画面はボタン自体を出し分けるが、Server Action 側でも UI 非表示に頼らず強制する §9)
  it('Free プランのテナントは拒否される', async () => {
    seedTenant(null, 'free');
    const { regenerateInboundToken } =
      await import('@/features/settings/actions/regenerate-inbound-token');
    await expect(regenerateInboundToken()).rejects.toThrow(
      'メール取り込みは Standard 以上のプランでご利用いただけます。',
    );
    // トークンは発行されないまま
    expect(store.tenants.get(TENANT_ID)?.inboundToken).toBeNull();
  });
});
