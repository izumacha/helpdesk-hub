// LINE メッセージ対応表リポジトリ (メモリアダプタ) の単体テスト。
// メッセージ ID → チケットの逆引き・冪等登録・クロステナント分離を検証する (DB を持ち込まない)。

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

describe('lineMessages (memory adapter)', () => {
  // 登録した LINE メッセージ ID から、その後正しく ticketId を逆引きできる
  it('登録したメッセージ ID からチケットを逆引きできる', async () => {
    await repos.lineMessages.register({
      lineMessageId: 'm1',
      ticketId: 't1',
      tenantId: TENANT_A,
    });
    const found = await repos.lineMessages.findTicketIdByMessageId('m1', TENANT_A);
    expect(found).toBe('t1');
  });

  // 未登録のメッセージ ID は null
  it('未登録のメッセージ ID は null を返す', async () => {
    expect(await repos.lineMessages.findTicketIdByMessageId('unknown', TENANT_A)).toBeNull();
  });

  // 同じ (tenant, lineMessageId) を二重登録しても 1 件のまま (冪等)
  it('同一メッセージ ID の二重登録は冪等', async () => {
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't1', tenantId: TENANT_A });
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't1', tenantId: TENANT_A });
    // ストア上は 1 件だけ
    expect(store.lineMessageRefs.size).toBe(1);
  });

  // 別テナントのメッセージ ID は突き合わせ対象にしない (クロステナント遮断)
  it('別テナントのメッセージ ID は逆引きできない', async () => {
    // テナント B に登録したメッセージ ID を…
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't-b', tenantId: TENANT_B });
    // テナント A のスコープで引いても見つからない
    expect(await repos.lineMessages.findTicketIdByMessageId('m1', TENANT_A)).toBeNull();
    // 同じメッセージ ID でも自テナント (B) では引ける
    expect(await repos.lineMessages.findTicketIdByMessageId('m1', TENANT_B)).toBe('t-b');
  });
});
