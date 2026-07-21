// deleteCategory (Server Action) のテスト。
// 管理者ゲート・レート制限・テナント分離・紐づくチケットのcategoryId SetNullをメモリアダプタで検証する。
// delete-location.test.ts と同じ設計 (フォローアップ 2026-07-21)。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import type { Role } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
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

describe('deleteCategory', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionRole = 'admin';
    sessionTenantId = TENANT_ID;
    __resetRateLimits();
  });

  // 正常系: カテゴリを削除できる
  it('カテゴリを削除できる', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    const result = await deleteCategory(category.id);
    expect(result.success).toBe(true);
    const reloaded = await repos.categories.findById(category.id, TENANT_ID);
    expect(reloaded).toBeNull();
  });

  // 削除成功時に監査ログへ記録されること
  it('削除成功時に監査ログへ記録される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    await deleteCategory(category.id);
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('category_delete');
  });

  // admin 以外 (agent) は拒否される
  it('agent ロールは拒否される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    sessionRole = 'agent';
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    const result = await deleteCategory(category.id);
    expect(result.error).toBe('この操作は管理者のみ実行できます');
    const reloaded = await repos.categories.findById(category.id, TENANT_ID);
    expect(reloaded).not.toBeNull();
  });

  // 未ログイン (tenantId 不在) は拒否される
  it('tenantIdが無いセッションは拒否される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    sessionTenantId = null;
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    const result = await deleteCategory(category.id);
    expect(result.error).toBe('認証が必要です');
    expect(result.success).toBeUndefined();
    const reloaded = await repos.categories.findById(category.id, TENANT_ID);
    expect(reloaded).not.toBeNull();
  });

  // 他テナントのカテゴリは削除できない (クロステナント防止)
  it('他テナントのカテゴリは削除できない', async () => {
    const category = await repos.categories.create({
      tenantId: OTHER_TENANT_ID,
      name: '他社カテゴリ',
    });
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    await deleteCategory(category.id);
    const reloaded = await repos.categories.findById(category.id, OTHER_TENANT_ID);
    expect(reloaded).not.toBeNull();
  });

  // 削除すると紐づくチケットの categoryId が null になる
  it('削除すると紐づくチケットのcategoryIdがnullになる', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    const now = new Date();
    store.tickets.set('ticket-1', {
      id: 'ticket-1',
      title: 'テスト',
      body: '本文',
      status: 'Open',
      priority: 'Medium',
      createdAt: now,
      updatedAt: now,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      firstRespondedAt: null,
      resolvedAt: null,
      escalatedAt: null,
      escalationReason: null,
      slaReminderNotifiedForDueAt: null,
      creatorId: 'creator-1',
      assigneeId: null,
      categoryId: category.id,
      locationId: null,
      tenantId: TENANT_ID,
    });

    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    await deleteCategory(category.id);

    expect(store.tickets.get('ticket-1')?.categoryId).toBeNull();
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const { deleteCategory } = await import('@/features/settings/actions/delete-category');
    for (let i = 0; i < 10; i++) {
      const category = await repos.categories.create({ tenantId: TENANT_ID, name: `カテゴリ${i}` });
      await deleteCategory(category.id);
    }
    const extra = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ11' });
    const result = await deleteCategory(extra.id);
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
