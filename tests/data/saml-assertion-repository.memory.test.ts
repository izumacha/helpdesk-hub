// SAML アサーションのリプレイ防止記録リポジトリ (メモリアダプタ) の単体テスト。
// (tenantId, assertionId) の初回記録・2回目以降の拒否・クロステナント分離を検証する (DB を持ち込まない)。

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

// 各テストでメモリ context を作り直す
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('samlAssertions (memory adapter)', () => {
  // 初回利用は記録され true が返る
  it('初回利用は記録して true を返す', async () => {
    const result = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_A,
      assertionId: '_a1',
    });
    expect(result).toBe(true);
    expect(store.samlAssertionRefs.size).toBe(1);
  });

  // 同一 (tenantId, assertionId) の2回目は false (リプレイ検知)
  it('同一アサーションの2回目は false を返し新規記録しない', async () => {
    await repos.samlAssertions.recordIfNew({ tenantId: TENANT_A, assertionId: '_a1' });
    const second = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_A,
      assertionId: '_a1',
    });
    expect(second).toBe(false);
    // ストア上は 1 件のまま (2件目は作られない)
    expect(store.samlAssertionRefs.size).toBe(1);
  });

  // 別テナントであれば同じ assertionId でも独立して初回扱いになる (クロステナント遮断)
  it('別テナントの同一 assertionId は独立して初回扱いになる', async () => {
    const forA = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_A,
      assertionId: 'same',
    });
    const forB = await repos.samlAssertions.recordIfNew({
      tenantId: TENANT_B,
      assertionId: 'same',
    });
    expect(forA).toBe(true);
    expect(forB).toBe(true);
    expect(store.samlAssertionRefs.size).toBe(2);
  });
});
