// チケットコメントリポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/ticket-comment-repository.memory.test.ts (メモリアダプタ)
// しかテストが無く、create() の「親チケットが指定 tenantId に属するかを検証し、不一致なら
// fail-closed で拒否する」(issue #123 のセキュリティ不変条件) が本番 Prisma アダプタで
// 実際に機能するかは未検証だった (CLAUDE.md §11)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const AUTHOR_A = 'author-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('TicketCommentRepository (prisma adapter)', () => {
  let prisma: PrismaClient;
  let ticketA: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'テナントA', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: 'テナントB', mode: 'lite' } });
    await prisma.user.create({
      data: {
        id: AUTHOR_A,
        email: 'author-a@example.com',
        name: '著者A',
        passwordHash: 'x',
        role: 'requester',
        tenantId: TENANT_A,
      },
    });
    const repos = buildPrismaRepos(prisma);
    const ticket = await repos.tickets.create({
      title: 'チケット',
      body: '本文',
      priority: 'Medium',
      creatorId: AUTHOR_A,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_A,
    });
    ticketA = ticket.id;
  });

  // 正常系: 自テナントのチケットにコメントを作成できる
  it('自テナントのチケットにコメントを作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const comment = await repos.comments.create({
      ticketId: ticketA,
      authorId: AUTHOR_A,
      body: 'ありがとうございます',
      tenantId: TENANT_A,
    });
    expect(comment.body).toBe('ありがとうございます');
  });

  // 異常系 (issue #123): 親チケットが指定 tenantId と異なる場合は fail-closed で拒否し、
  // 実際に DB に行が作られないことも確認する
  it('親チケットが別テナントの場合はエラーになり行が作成されない', async () => {
    const repos = buildPrismaRepos(prisma);
    await expect(
      repos.comments.create({
        ticketId: ticketA,
        authorId: AUTHOR_A,
        body: '不正なテナントから',
        tenantId: TENANT_B,
      }),
    ).rejects.toThrow();
    const count = await prisma.ticketComment.count({ where: { ticketId: ticketA } });
    expect(count).toBe(0);
  });

  // 異常系: 存在しないチケット ID はエラーになる
  it('存在しないチケットIDへのコメントはエラーになる', async () => {
    const repos = buildPrismaRepos(prisma);
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
