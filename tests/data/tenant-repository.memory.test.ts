// テナントリポジトリ (メモリアダプタ) の updateMode 単体テスト。
// Lite/Pro モード切替がテナント単位で正しく行われ、他テナントに波及しないことを確認する。

// Vitest の DSL とフック
import { beforeEach, describe, expect, it } from 'vitest';
// メモリ context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用テナント識別子
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// テストごとに作り直す依存
let store: Store;
let repos: Repos;

// テナント A・B を Lite モードで投入する共通シード
function seed() {
  // 現在時刻 (createdAt 用)
  const now = new Date();
  // テナント A・B を Lite モードで作成する
  for (const t of [TENANT_A, TENANT_B]) {
    store.tenants.set(t, { id: t, name: t, mode: 'lite', industry: null, createdAt: now });
  }
}

// updateMode の仕様確認テスト群
describe('TenantRepository.updateMode (memory)', () => {
  // 各テストの前にメモリ context を作り直してシードする
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 正常系: 指定テナントの mode を lite → pro に切り替えられる
  it('対象テナントの mode を pro に更新できる', async () => {
    // テナント A を pro に切り替える
    const updated = await repos.tenants.updateMode(TENANT_A, 'pro');
    // 戻り値の mode が pro になっている
    expect(updated.mode).toBe('pro');
    // 再取得しても pro が永続化されている
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.mode).toBe('pro');
  });

  // 分離: あるテナントの更新が他テナントに波及しない
  it('他テナントの mode には影響しない', async () => {
    // テナント A だけを pro に切り替える
    await repos.tenants.updateMode(TENANT_A, 'pro');
    // テナント B は元の lite のままであること
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.mode).toBe('lite');
  });

  // 異常系: 存在しないテナント ID はエラーになる (fail-closed)
  it('存在しないテナント ID はエラーになる', async () => {
    // 未登録の ID で更新しようとすると reject される
    await expect(repos.tenants.updateMode('no-such-tenant', 'pro')).rejects.toThrow();
  });

  // 冪等: 同じ mode への更新でも成功し値が保たれる
  it('同じ mode への更新でも値が保たれる', async () => {
    // 既に lite のテナントを lite に更新する
    const updated = await repos.tenants.updateMode(TENANT_A, 'lite');
    // mode は lite のまま
    expect(updated.mode).toBe('lite');
  });
});
