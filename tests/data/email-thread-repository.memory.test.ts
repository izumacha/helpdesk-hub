// メールスレッド対応表リポジトリ (メモリアダプタ) の単体テスト。
// Message-ID → チケットの逆引き・冪等登録・クロステナント分離を検証する (DB を持ち込まない)。

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

describe('emailThreads (memory adapter)', () => {
  // 登録した Message-ID から、その後正しく ticketId を逆引きできる
  it('登録した Message-ID からチケットを逆引きできる', async () => {
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't1',
      tenantId: TENANT_A,
    });
    // 参照に m1 を含めれば t1 が返る
    const found = await repos.emailThreads.findTicketIdByMessageIds(['m1@x.com'], TENANT_A);
    expect(found).toBe('t1');
  });

  // 参照が空 / 未登録なら null
  it('未登録・空参照なら null を返す', async () => {
    expect(await repos.emailThreads.findTicketIdByMessageIds([], TENANT_A)).toBeNull();
    expect(
      await repos.emailThreads.findTicketIdByMessageIds(['unknown@x.com'], TENANT_A),
    ).toBeNull();
  });

  // 同じ (tenant, messageId) を二重登録しても 1 件のまま (冪等)
  it('同一 Message-ID の二重登録は冪等', async () => {
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't1',
      tenantId: TENANT_A,
    });
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't1',
      tenantId: TENANT_A,
    });
    // ストア上は 1 件だけ
    expect(store.emailThreadRefs.size).toBe(1);
  });

  // 別テナントの Message-ID は突き合わせ対象にしない (クロステナント遮断)
  it('別テナントの Message-ID は逆引きできない', async () => {
    // テナント B に登録した Message-ID を…
    await repos.emailThreads.register({
      messageId: 'm1@x.com',
      ticketId: 't-b',
      tenantId: TENANT_B,
    });
    // テナント A のスコープで引いても見つからない
    expect(await repos.emailThreads.findTicketIdByMessageIds(['m1@x.com'], TENANT_A)).toBeNull();
    // 同じ Message-ID でも自テナント (B) では引ける
    expect(await repos.emailThreads.findTicketIdByMessageIds(['m1@x.com'], TENANT_B)).toBe('t-b');
  });

  // 実運用ではスレッド上の複数 Message-ID (元メール + 過去返信) は同じチケットを指す。
  // どの参照を渡しても、また複数まとめて渡しても、そのチケットが返ることを保証する。
  it('同一チケットの複数 Message-ID はどの参照でも同じチケットを返す', async () => {
    // 1 つのチケット t1 に、元メールと返信メールの 2 つの Message-ID を紐づける
    await repos.emailThreads.register({
      messageId: 'orig@x.com',
      ticketId: 't1',
      tenantId: TENANT_A,
    });
    await repos.emailThreads.register({
      messageId: 'reply@x.com',
      ticketId: 't1',
      tenantId: TENANT_A,
    });
    // 個別に引いても、まとめて引いても t1 が返る
    expect(await repos.emailThreads.findTicketIdByMessageIds(['orig@x.com'], TENANT_A)).toBe('t1');
    expect(await repos.emailThreads.findTicketIdByMessageIds(['reply@x.com'], TENANT_A)).toBe('t1');
    expect(
      await repos.emailThreads.findTicketIdByMessageIds(['orig@x.com', 'reply@x.com'], TENANT_A),
    ).toBe('t1');
  });
});
