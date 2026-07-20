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

  // §4.3 フォローアップ: 更新成功時に監査ログへ記録されること
  it('更新成功時に監査ログへ記録される', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '旧名称',
      description: null,
    });
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    await updateLocation(location.id, makeForm('新名称'));
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('location_update');
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

  // 未ログイン (tenantId 不在) は拒否される。他の設定系アクションと同じ「認証が必要です」で揃える
  it('tenantIdが無いセッションは拒否される', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '拠点',
      description: null,
    });
    sessionTenantId = null;
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const result = await updateLocation(location.id, makeForm('新名称'));
    expect(result.error).toBe('認証が必要です');
    expect(result.success).toBeUndefined();
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

  // フォローアップ (監査で発見したギャップ): この編集フォームは常に現在値を全項目
  // defaultValue で事前入力して丸ごと再送信する構成のため、読み取り (existing) →検証→
  // 無条件書き込みの check-then-act (TOCTOU) だった。他の管理者が並行して拠点名を
  // 変更した直後にこのリクエストが割り込むと、古い値のまま上書きして変更を黙って
  // 巻き戻してしまう。CAS 化により 0 件更新 (競合) を検知し、後勝ちで上書きしないことを
  // 確認する (update-line-config.test.ts と同じ手法)
  it('他の管理者による並行更新と競合すると保存されず、その値を上書きしない', async () => {
    const location = await repos.locations.create({
      tenantId: TENANT_ID,
      name: '元の名前',
      description: '元の説明',
    });
    const stale = await repos.locations.findById(location.id, TENANT_ID);
    if (!stale) throw new Error('seed missing location');
    // 並行更新を模す: 先に別の管理者が名前を変更したことにする
    await repos.locations.update(location.id, TENANT_ID, { name: '並行更新後の名前' });
    // findById だけが古いスナップショット (変更前) を返す状況を作る (TOCTOU の再現)
    vi.spyOn(repos.locations, 'findById').mockResolvedValueOnce(stale);
    const { updateLocation } = await import('@/features/settings/actions/update-location');
    const result = await updateLocation(location.id, makeForm('このリクエストの新名称'));
    expect(result.error).toBe(
      '他の管理者による変更と競合しました。最新の設定を確認してから再度お試しください。',
    );
    expect(result.success).toBeUndefined();
    // 並行更新後の値が上書きされずに残っている
    const saved = await repos.locations.findById(location.id, TENANT_ID);
    expect(saved?.name).toBe('並行更新後の名前');
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
