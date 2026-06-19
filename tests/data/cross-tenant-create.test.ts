// クロステナント作成拒否の単体テスト (issue #123)。
// コメント / 添付の create Adapter が「親チケットのテナント一致」を fail-closed で
// 検証することを確認する。呼び出し側の tenant チェック漏れに対する多層防御の最終段。

// Vitest の DSL とフック
import { beforeEach, describe, expect, it } from 'vitest';
// メモリ context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用テナント / ユーザー識別子
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'u-a';

// テストごとに作り直す依存
let store: Store;
let repos: Repos;

// テナント A・B と、テナント A のチケットを 1 件投入する共通シード
async function seed() {
  // 現在時刻 (createdAt 用)
  const now = new Date();
  // テナント A・B を投入 (Lite モード)
  for (const t of [TENANT_A, TENANT_B]) {
    store.tenants.set(t, { id: t, name: t, mode: 'lite', industry: null, inboundToken: null, createdAt: now });
  }
  // テナント A のユーザーを 1 人投入する
  store.users.set(USER_A, {
    id: USER_A,
    email: 'a@example.com',
    name: 'A',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT_A,
    createdAt: now,
    updatedAt: now,
  });
  // テナント A のチケットを 1 件作成し、その ID を返す
  const ticket = await repos.tickets.create({
    title: 'A',
    body: 'a',
    priority: 'Medium',
    creatorId: USER_A,
    categoryId: null,
    tenantId: TENANT_A,
  });
  // 後続テストで参照するチケット ID を返す
  return ticket.id;
}

// クロステナント作成拒否の仕様確認テスト群
describe('cross-tenant create guards (#123)', () => {
  // 各テストの前にメモリ context を作り直す
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // 同テナントならコメントを作成できる
  it('allows commenting on a ticket in the same tenant', async () => {
    // テナント A のチケットを用意する
    const ticketId = await seed();
    // 同じテナント A 指定でコメント作成 → 成功する
    const comment = await repos.comments.create({
      ticketId,
      authorId: USER_A,
      body: 'こんにちは',
      tenantId: TENANT_A,
    });
    // 作成されたコメントが対象チケットに紐づくこと
    expect(comment.ticketId).toBe(ticketId);
  });

  // 別テナント指定のコメント作成は拒否される
  it('rejects commenting with a mismatched tenant', async () => {
    // テナント A のチケットを用意する
    const ticketId = await seed();
    // テナント B を名乗ってテナント A のチケットへコメント → 拒否される
    await expect(
      repos.comments.create({
        ticketId,
        authorId: USER_A,
        body: '侵入',
        tenantId: TENANT_B,
      }),
    ).rejects.toThrow(/チケットが見つかりません/);
  });

  // 存在しないチケット ID へのコメント作成も拒否される
  it('rejects commenting on a non-existent ticket', async () => {
    // テナント A を用意する (チケットは存在しない ID を指定)
    await seed();
    // 実在しないチケット ID へコメント → 拒否される
    await expect(
      repos.comments.create({
        ticketId: 'no-such-ticket',
        authorId: USER_A,
        body: '宛先なし',
        tenantId: TENANT_A,
      }),
    ).rejects.toThrow(/チケットが見つかりません/);
  });
});
