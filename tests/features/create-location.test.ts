// createLocation (Server Action) のテスト。
// 管理者ゲート・レート制限・入力検証・重複名エラーをメモリアダプタで検証する。
// これまでこのアクションにテストが存在しなかったギャップを埋める。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import type { Role } from '@/domain/types';

const TENANT_ID = 'tenant-1';
const USER_ID = 'u-admin-1';

let repos: Repos;
let sessionRole: Role = 'admin';

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: USER_ID, role: sessionRole, tenantId: TENANT_ID },
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

describe('createLocation', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    repos = ctx.repos;
    sessionRole = 'admin';
    __resetRateLimits();
  });

  // 正常系: 拠点を作成できる
  it('拠点を作成できる', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm('渋谷本店', '本社'));
    expect(result.locationId).toEqual(expect.any(String));
    expect(result.error).toBeUndefined();
  });

  // admin 以外 (agent) は拒否される
  it('agent ロールは拒否される', async () => {
    sessionRole = 'agent';
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm('渋谷本店'));
    expect(result.error).toBe('この操作は管理者のみ実行できます');
    expect(result.locationId).toBeUndefined();
  });

  // 拠点名が空なら拒否される
  it('拠点名が空なら拒否される', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm(''));
    expect(result.error).toBe('拠点名は必須です');
  });

  // 拠点名が101文字以上なら拒否される
  it('拠点名が長すぎる場合は拒否される', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm('あ'.repeat(101)));
    expect(result.error).toBe('拠点名は100文字以内で入力してください');
  });

  // 同名の拠点は重複エラーになる
  it('同名の拠点は重複エラーになる', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    await createLocation(makeForm('渋谷本店'));
    const result = await createLocation(makeForm('渋谷本店'));
    expect(result.error).toBe('この拠点名はすでに使用されています');
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    for (let i = 0; i < 10; i++) {
      await createLocation(makeForm(`拠点${i}`));
    }
    const result = await createLocation(makeForm('拠点11'));
    expect(result.error).toEqual(expect.any(String));
    expect(result.locationId).toBeUndefined();
  });
});
