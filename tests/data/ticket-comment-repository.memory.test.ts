// チケットコメントリポジトリ (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: TicketCommentRepository には Port/Prisma/メモリの各アダプタが揃って
// いるのにテストが 1 つも無かった。create() の「親チケットが指定 tenantId に属するかを検証し、
// 不一致なら fail-closed で拒否する」(issue #123) という非自明な同時検証が未検証だった。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const AUTHOR_A = 'author-a';

let store: Store;
let repos: Repos;

// 指定テナントにチケットを 1 件用意する
async function seedTicket(tenantId: string, creatorId: string) {
  const now = new Date();
  store.users.set(creatorId, {
    id: creatorId,
    email: `${creatorId}@example.com`,
    name: creatorId,
    passwordHash: 'x',
    role: 'requester',
    tenantId,
    createdAt: now,
    updatedAt: now,
  });
  return repos.tickets.create({
    title: 'チケット',
    body: '本文',
    priority: 'Medium',
    creatorId,
    categoryId: null,
    locationId: null,
    tenantId,
  });
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('TicketCommentRepository (memory)', () => {
  // 正常系: 自テナントのチケットにコメントを作成できる
  it('自テナントのチケットにコメントを作成できる', async () => {
    const ticket = await seedTicket(TENANT_A, AUTHOR_A);
    const comment = await repos.comments.create({
      ticketId: ticket.id,
      authorId: AUTHOR_A,
      body: 'ありがとうございます',
      tenantId: TENANT_A,
    });
    expect(comment.body).toBe('ありがとうございます');
    expect(comment.ticketId).toBe(ticket.id);
  });

  // 異常系 (issue #123): 親チケットが指定 tenantId と異なる場合は fail-closed で拒否する
  // (攻撃者がセッション由来でない tenantId を渡してもクロステナントでコメントできないことの検証)
  it('親チケットが別テナントの場合はエラーになる', async () => {
    const ticket = await seedTicket(TENANT_A, AUTHOR_A);
    await expect(
      repos.comments.create({
        ticketId: ticket.id,
        authorId: AUTHOR_A,
        body: '不正なテナントから',
        tenantId: TENANT_B,
      }),
    ).rejects.toThrow();
  });

  // 異常系: 存在しないチケット ID はエラーになる
  it('存在しないチケットIDへのコメントはエラーになる', async () => {
    await expect(
      repos.comments.create({
        ticketId: 'no-such-ticket',
        authorId: AUTHOR_A,
        body: '本文',
        tenantId: TENANT_A,
      }),
    ).rejects.toThrow();
  });
});
