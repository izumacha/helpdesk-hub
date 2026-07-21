// createCategory (Server Action) のテスト。
// 管理者ゲート・レート制限・入力検証・重複名エラーをメモリアダプタで検証する。
// create-location.test.ts と同じ設計 (フォローアップ 2026-07-21)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import type { Role, TenantMode } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const USER_ID = 'u-admin-1';

let store: Store;
let repos: Repos;
let sessionRole: Role = 'admin';
let sessionTenantId: string | null = TENANT_ID;

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: USER_ID, role: sessionRole, tenantId: sessionTenantId },
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

function makeForm(name: string): FormData {
  const fd = new FormData();
  fd.set('name', name);
  return fd;
}

// フォローアップ (2026-07-21): カテゴリ管理は Pro モード専用のため、指定した mode の
// テナントをシードする (assertCategoryManagementAdmin が参照する)
function seedTenant(mode: TenantMode) {
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'テスト組織',
    mode,
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    subscriptionPlan: 'pro',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    createdAt: new Date(),
  });
}

describe('createCategory', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionRole = 'admin';
    sessionTenantId = TENANT_ID;
    seedTenant('pro');
    __resetRateLimits();
  });

  // フォローアップ (2026-07-21): カテゴリ管理は Pro モード専用。UI 非表示だけに頼らず
  // サーバー側でも mode を強制する (§9 セキュリティ)
  it('Liteモードのテナントは拒否される', async () => {
    seedTenant('lite');
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm('ネットワーク'));
    expect(result.error).toBe('カテゴリ管理は Pro モードでのみ利用できます。');
    expect(result.categoryId).toBeUndefined();
  });

  // 正常系: カテゴリを作成できる
  it('カテゴリを作成できる', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm('ネットワーク'));
    expect(result.categoryId).toEqual(expect.any(String));
    expect(result.error).toBeUndefined();
  });

  // 作成成功時に監査ログへ記録されること
  it('作成成功時に監査ログへ記録される', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    await createCategory(makeForm('ネットワーク'));
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('category_create');
    expect(auditLogs[0].actorId).toBe(USER_ID);
  });

  // 監査ログの書き込みが失敗してもカテゴリ作成自体は成功として扱われる
  it('監査ログの書き込みが失敗しても作成自体は成功として扱われる', async () => {
    vi.spyOn(repos.settingsAudit, 'record').mockRejectedValueOnce(new Error('DB down'));
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm('ネットワーク'));
    expect(result.categoryId).toEqual(expect.any(String));
    expect(result.error).toBeUndefined();
  });

  // admin 以外 (agent) は拒否される
  it('agent ロールは拒否される', async () => {
    sessionRole = 'agent';
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm('ネットワーク'));
    expect(result.error).toBe('この操作は管理者のみ実行できます');
    expect(result.categoryId).toBeUndefined();
  });

  // 未ログイン (tenantId 不在) は拒否される
  it('tenantIdが無いセッションは拒否される', async () => {
    sessionTenantId = null;
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm('ネットワーク'));
    expect(result.error).toBe('認証が必要です');
    expect(result.categoryId).toBeUndefined();
  });

  // カテゴリ名が空なら拒否される
  it('カテゴリ名が空なら拒否される', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm(''));
    expect(result.error).toBe('カテゴリ名は必須です');
  });

  // カテゴリ名が101文字以上なら拒否される
  it('カテゴリ名が長すぎる場合は拒否される', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const result = await createCategory(makeForm('あ'.repeat(101)));
    expect(result.error).toBe('カテゴリ名は100文字以内で入力してください');
  });

  // 同名のカテゴリは重複エラーになる
  it('同名のカテゴリは重複エラーになる', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    await createCategory(makeForm('ネットワーク'));
    const result = await createCategory(makeForm('ネットワーク'));
    expect(result.error).toBe('このカテゴリ名はすでに使用されています');
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    for (let i = 0; i < 10; i++) {
      await createCategory(makeForm(`カテゴリ${i}`));
    }
    const result = await createCategory(makeForm('カテゴリ11'));
    expect(result.error).toEqual(expect.any(String));
    expect(result.categoryId).toBeUndefined();
  });

  // レート制限はテナント単位で create/update/delete が共有する
  it('create/update/deleteでレート制限を共有する', async () => {
    const { createCategory } = await import('@/features/settings/actions/create-category');
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');

    for (let i = 0; i < 10; i++) {
      const result = await createCategory(makeForm(`カテゴリ${i}`));
      expect(result.error).toBeUndefined();
    }

    const updateResult = await updateCategory('any-id', makeForm('新名称'));
    expect(updateResult.error).toEqual(expect.any(String));
    const deleteResult = await deleteCategory('any-id');
    expect(deleteResult.error).toEqual(expect.any(String));
  });
});
