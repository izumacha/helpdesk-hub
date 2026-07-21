// updateCategory (Server Action) のテスト。
// 管理者ゲート・レート制限・入力検証・テナント分離・CAS競合をメモリアダプタで検証する。
// update-location.test.ts と同じ設計 (フォローアップ 2026-07-21)。

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

describe('updateCategory', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    repos = ctx.repos;
    sessionRole = 'admin';
    sessionTenantId = TENANT_ID;
    __resetRateLimits();
  });

  // 正常系: 名前を更新できる
  it('カテゴリを更新できる', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: '旧名称' });
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm('新名称'));
    expect(result.success).toBe(true);
    const reloaded = await repos.categories.findById(category.id, TENANT_ID);
    expect(reloaded?.name).toBe('新名称');
  });

  // 更新成功時に監査ログへ記録されること
  it('更新成功時に監査ログへ記録される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: '旧名称' });
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    await updateCategory(category.id, makeForm('新名称'));
    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('category_update');
  });

  // admin 以外 (agent) は拒否される
  it('agent ロールは拒否される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    sessionRole = 'agent';
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm('新名称'));
    expect(result.error).toBe('この操作は管理者のみ実行できます');
  });

  // 未ログイン (tenantId 不在) は拒否される
  it('tenantIdが無いセッションは拒否される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    sessionTenantId = null;
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm('新名称'));
    expect(result.error).toBe('認証が必要です');
    expect(result.success).toBeUndefined();
  });

  // 他テナントのカテゴリは更新できない (クロステナント防止)
  it('他テナントのカテゴリは更新できない', async () => {
    const category = await repos.categories.create({
      tenantId: OTHER_TENANT_ID,
      name: '他社カテゴリ',
    });
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm('乗っ取り'));
    expect(result.error).toBeDefined();
    expect(result.success).toBeUndefined();
    const reloaded = await repos.categories.findById(category.id, OTHER_TENANT_ID);
    expect(reloaded?.name).toBe('他社カテゴリ');
  });

  // カテゴリ名が空なら拒否される
  it('カテゴリ名が空なら拒否される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm(''));
    expect(result.error).toBe('カテゴリ名は必須です');
  });

  // フォローアップ (監査で発見したギャップ): この編集フォームは常に現在値を defaultValue で
  // 事前入力して丸ごと再送信する構成のため、読み取り (existing) →検証→無条件書き込みの
  // check-then-act (TOCTOU) だった。CAS 化により 0 件更新 (競合) を検知し、後勝ちで
  // 上書きしないことを確認する (update-location.test.ts と同じ手法)
  it('他の管理者による並行更新と競合すると保存されず、その値を上書きしない', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: '元の名前' });
    const stale = await repos.categories.findById(category.id, TENANT_ID);
    if (!stale) throw new Error('seed missing category');
    // 並行更新を模す: 先に別の管理者が名前を変更したことにする
    await repos.categories.update(category.id, TENANT_ID, { name: '並行更新後の名前' });
    // findById だけが古いスナップショット (変更前) を返す状況を作る (TOCTOU の再現)
    vi.spyOn(repos.categories, 'findById').mockResolvedValueOnce(stale);
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm('このリクエストの新名称'));
    expect(result.error).toBe(
      '他の管理者による変更と競合しました。最新の設定を確認してから再度お試しください。',
    );
    expect(result.success).toBeUndefined();
    const saved = await repos.categories.findById(category.id, TENANT_ID);
    expect(saved?.name).toBe('並行更新後の名前');
  });

  // 重複する名前へのリネームは拒否される
  it('重複する名前へのリネームは拒否される', async () => {
    await repos.categories.create({ tenantId: TENANT_ID, name: '既存カテゴリ' });
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: '変更対象' });
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    const result = await updateCategory(category.id, makeForm('既存カテゴリ'));
    expect(result.error).toBe('このカテゴリ名はすでに使用されています');
  });

  // レート制限: 60秒あたり10回を超える連打は拒否される
  it('60秒あたり10回を超える連打は拒否される', async () => {
    const category = await repos.categories.create({ tenantId: TENANT_ID, name: 'カテゴリ' });
    const { updateCategory } = await import('@/features/settings/actions/update-category');
    for (let i = 0; i < 10; i++) {
      await updateCategory(category.id, makeForm(`カテゴリ${i}`));
    }
    const result = await updateCategory(category.id, makeForm('カテゴリ11'));
    expect(result.error).toEqual(expect.any(String));
    expect(result.success).toBeUndefined();
  });
});
