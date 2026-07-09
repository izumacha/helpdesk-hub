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
// 未ログイン (tenantId 不在) の分岐を再現するために可変にする
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
    sessionTenantId = TENANT_ID;
    __resetRateLimits();
  });

  // 正常系: 拠点を作成できる
  it('拠点を作成できる', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm('渋谷本店', '本社'));
    expect(result.locationId).toEqual(expect.any(String));
    expect(result.error).toBeUndefined();
  });

  // §4.3 フォローアップ: 作成成功時に監査ログへ記録されること
  it('作成成功時に監査ログへ記録される', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    await createLocation(makeForm('渋谷本店'));
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('location_create');
    expect(auditLogs[0].actorId).toBe(USER_ID);
  });

  // §4.2/§4.3 の共通方針: 監査ログの書き込みが失敗しても拠点作成自体は成功として扱われる
  it('監査ログの書き込みが失敗しても作成自体は成功として扱われる', async () => {
    vi.spyOn(repos.settingsAudit, 'record').mockRejectedValueOnce(new Error('DB down'));
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm('渋谷本店'));
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

  // 未ログイン (tenantId 不在) は拒否される。他の設定系アクション
  // (create-portal-session.ts 等) と同じ「認証が必要です」で揃える
  it('tenantIdが無いセッションは拒否される', async () => {
    sessionTenantId = null;
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const result = await createLocation(makeForm('渋谷本店'));
    expect(result.error).toBe('認証が必要です');
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

  // レート制限はテナント単位で create/update/delete が共有する (アクション別に分けると
  // 実質の上限が action 数倍になってしまうため)。create だけで上限を使い切ったら
  // update/delete も同じテナントでは拒否されることを確認する
  it('create/update/deleteでレート制限を共有する', async () => {
    const { createLocation } = await import('@/features/settings/actions/create-location');
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const { deleteLocation } = await import('@/features/settings/actions/delete-location');

    // create だけで上限 (10回) を使い切る
    for (let i = 0; i < 10; i++) {
      const result = await createLocation(makeForm(`拠点${i}`));
      expect(result.error).toBeUndefined();
    }

    // 同じテナントの update/delete も共有の上限に達しているため拒否される
    const updateResult = await updateLocation('any-id', makeForm('新名称'));
    expect(updateResult.error).toEqual(expect.any(String));
    const deleteResult = await deleteLocation('any-id');
    expect(deleteResult.error).toEqual(expect.any(String));
  });
});
