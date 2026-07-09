// updateLocation (Server Action) のテスト。
// 管理者ゲート・レート制限・入力検証・テナント分離をメモリアダプタで検証する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import type { Role } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const USER_ID = 'u-admin-1';

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

function makeForm(name: string, description = ''): FormData {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('description', description);
  return fd;
}

describe('updateLocation', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    repos = ctx.repos;
    sessionRole = 'admin';
    sessionTenantId = TENANT_ID;
    __resetRateLimits();
  });

  // 正常系: 名前・説明を更新できる
  it('拠点を更新できる', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '旧名称',
      description: null,
    });
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const result = await updateLocation(location.id, makeForm('新名称', '新説明'));
    expect(result.success).toBe(true);
    const reloaded = await repos.locations.findById(location.id, TENANT_ID);
    expect(reloaded?.name).toBe('新名称');
  });

  // admin 以外 (agent) は拒否される
  it('agent ロールは拒否される', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
    sessionRole = 'agent';
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const result = await updateLocation(location.id, makeForm('新名称'));
    expect(result.error).toBe('この操作は管理者のみ実行できます');
  });

  // 他テナントの拠点は更新できない (クロステナント防止)
  it('他テナントの拠点は更新できない', async () => {
    const location = await repos.locations.create({
      tenantId: OTHER_TENANT_ID,
      name: '他社拠点',
      description: null,
    });
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const result = await updateLocation(location.id, makeForm('乗っ取り'));
    expect(result.error).toBeDefined();
    expect(result.success).toBeUndefined();
    // 他テナント側のデータは変更されていないこと
    const reloaded = await repos.locations.findById(location.id, OTHER_TENANT_ID);
    expect(reloaded?.name).toBe('他社拠点');
  });

  // 拠点名が空なら拒否される
  it('拠点名が空なら拒否される', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const result = await updateLocation(location.id, makeForm(''));
    expect(result.error).toBe('拠点名は必須です');
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    for (let i = 0; i < 10; i++) {
      await updateLocation(location.id, makeForm(`拠点${i}`));
    }
    const result = await updateLocation(location.id, makeForm('拠点11'));
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
