// FAQ リポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/faq-repository.memory.test.ts (メモリアダプタ) しかテストが
// 無く、list() の include (ticket/createdBy の JOIN) や updateMany によるテナントスコープ更新が
// 本番 Prisma アダプタで実際に動くかは未検証だった (CLAUDE.md §11)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const AGENT_A = 'agent-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('FaqRepository (prisma adapter)', () => {
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
        id: AGENT_A,
        email: 'agent-a@example.com',
        name: 'エージェントA',
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_A,
      },
    });
    const repos = buildPrismaRepos(prisma);
    const ticket = await repos.tickets.create({
      title: 'テナントAのチケット',
      body: '本文',
      priority: 'Medium',
      creatorId: AGENT_A,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_A,
    });
    ticketA = ticket.id;
  });

  // 新規 FAQ 候補を作成できる (初期状態は Candidate)
  it('新規FAQ候補を作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: '印刷できないときは?',
      answer: '電源を確認してください',
      tenantId: TENANT_A,
    });
    expect(faq.status).toBe('Candidate');
  });

  // findById: 他テナントの ID は null (クロステナント漏洩防止)
  it('findByIdは他テナントのIDにnullを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    expect(await repos.faq.findById(faq.id, TENANT_B)).toBeNull();
  });

  // list: 関連チケット/作成者名を JOIN して返す (include の実 DB 動作確認)
  it('listは関連チケット・作成者名を結合して返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'QA',
      answer: 'AA',
      tenantId: TENANT_A,
    });
    const result = await repos.faq.list(TENANT_A);
    expect(result).toHaveLength(1);
    expect(result[0].ticket.title).toBe('テナントAのチケット');
    expect(result[0].createdBy.name).toBe('エージェントA');
  });

  // updateStatus: tenantId スコープの updateMany が正しく更新する
  it('updateStatusで状態を更新できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    await repos.faq.updateStatus(faq.id, 'Published', TENANT_A);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Published');
  });

  // updateStatus: 他テナントの ID は no-op (updateMany が 0 件更新)
  it('updateStatusは他テナントのIDに対してno-opになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const faq = await repos.faq.create({
      ticketId: ticketA,
      createdById: AGENT_A,
      question: 'Q',
      answer: 'A',
      tenantId: TENANT_A,
    });
    await repos.faq.updateStatus(faq.id, 'Published', TENANT_B);
    const reloaded = await repos.faq.findById(faq.id, TENANT_A);
    expect(reloaded?.status).toBe('Candidate');
  });
});
