// deleteLocation (Server Action) のテスト。
// 管理者ゲート・レート制限・テナント分離・紐づくチケットのlocationId SetNullをメモリアダプタで検証する。

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
let sessionTenantId: string = TENANT_ID;

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

describe('deleteLocation', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sessionRole = 'admin';
    sessionTenantId = TENANT_ID;
    __resetRateLimits();
  });

  // 正常系: 拠点を削除できる
  it('拠点を削除できる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
    const { deleteLocation } = await import('@/features/settings/actions/delete-location');
    const result = await deleteLocation(location.id);
    expect(result.success).toBe(true);
    const reloaded = await repos.locations.findById(location.id, TENANT_ID);
    expect(reloaded).toBeNull();
  });

  // admin 以外 (agent) は拒否される
  it('agent ロールは拒否される', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
    sessionRole = 'agent';
    const { deleteLocation } = await import('@/features/settings/actions/delete-location');
    const result = await deleteLocation(location.id);
    expect(result.error).toBe('この操作は管理者のみ実行できます');
    // 削除されていないこと
    const reloaded = await repos.locations.findById(location.id, TENANT_ID);
    expect(reloaded).not.toBeNull();
  });

  // 他テナントの拠点は削除できない (クロステナント防止)
  it('他テナントの拠点は削除できない', async () => {
    const location = await repos.locations.create({
      tenantId: OTHER_TENANT_ID,
      name: '他社拠点',
      description: null,
    });
    const { deleteLocation } = await import('@/features/settings/actions/delete-location');
    await deleteLocation(location.id);
    // 他テナント側から見ればまだ存在していること (no-op)
    const reloaded = await repos.locations.findById(location.id, OTHER_TENANT_ID);
    expect(reloaded).not.toBeNull();
  });

  // 削除すると紐づくチケットの locationId が null になる
  it('削除すると紐づくチケットのlocationIdがnullになる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
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
      creatorId: 'creator-1',
      assigneeId: null,
      categoryId: null,
      locationId: location.id,
      tenantId: TENANT_ID,
    });

    const { deleteLocation } = await import('@/features/settings/actions/delete-location');
    await deleteLocation(location.id);

    expect(store.tickets.get('ticket-1')?.locationId).toBeNull();
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const { deleteLocation } = await import('@/features/settings/actions/delete-location');
    for (let i = 0; i < 10; i++) {
      const location = await repos.locations.create({
        tenantId: TENANT_ID,
        name: `拠点${i}`,
        description: null,
      });
      await deleteLocation(location.id);
    }
    const extra = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点11',
      description: null,
    });
    const result = await deleteLocation(extra.id);
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
