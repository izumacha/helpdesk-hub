// チケット履歴リポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/ticket-history-repository.memory.test.ts (メモリアダプタ)
// しかテストが無く、TicketHistory 自体は tenantId 列を持たないため「親チケット経由でテナント
// スコープを判定する」(where: { ticket: { tenantId } }) という設計が本番 Prisma アダプタで
// 実際にクロステナント漏洩を防げているかは未検証だった。/audit 画面 (Pro/Enterprise 限定) が
// 直接依存する集計のため重要度が高い (CLAUDE.md §11)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('TicketHistoryRepository (prisma adapter)', () => {
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
        id: USER_A,
        email: 'user-a@example.com',
        name: 'ユーザーA',
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
      creatorId: USER_A,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_A,
    });
    ticketA = ticket.id;
  });

  // record: 履歴を1件記録できる
  it('履歴を1件記録できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.history.record({
      ticketId: ticketA,
      changedById: USER_A,
      field: 'status',
      oldValue: 'New',
      newValue: 'Open',
    });
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rows).toHaveLength(1);
    expect(rows[0].newValue).toBe('Open');
  });

  // findAllByTenant: 親チケット経由でテナントスコープを判定し、他テナントの履歴は含まない
  // (TicketHistory 自体は tenantId 列を持たない設計のため、実 DB での検証が最重要)
  it('findAllByTenantは親チケット経由でテナントスコープを判定し他テナントの履歴を含まない', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.history.record({
      ticketId: ticketA,
      changedById: USER_A,
      field: 'priority',
      oldValue: 'Medium',
      newValue: 'High',
    });
    const userB = 'user-b';
    await prisma.user.create({
      data: {
        id: userB,
        email: 'user-b@example.com',
        name: 'ユーザーB',
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_B,
      },
    });
    const ticketB = await repos.tickets.create({
      title: 'テナントBのチケット',
      body: '本文',
      priority: 'Medium',
      creatorId: userB,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_B,
    });
    await repos.history.record({
      ticketId: ticketB.id,
      changedById: userB,
      field: 'priority',
      oldValue: 'Low',
      newValue: 'Medium',
    });

    const rowsA = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].ticketTitle).toBe('テナントAのチケット');
  });

  // findAllByTenant: 新しい順に並べる
  it('findAllByTenantは新しい順に並べる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.history.record({
      ticketId: ticketA,
      changedById: USER_A,
      field: 'status',
      oldValue: 'New',
      newValue: 'Open',
    });
    await repos.history.record({
      ticketId: ticketA,
      changedById: USER_A,
      field: 'status',
      oldValue: 'Open',
      newValue: 'InProgress',
    });
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A });
    expect(rows.map((r) => r.newValue)).toEqual(['InProgress', 'Open']);
  });

  // findAllByTenant: limit で件数を絞り込める (§8 一覧取得は必ず上限を持たせる)
  it('limitで件数を絞り込める', async () => {
    const repos = buildPrismaRepos(prisma);
    for (let i = 0; i < 3; i++) {
      await repos.history.record({
        ticketId: ticketA,
        changedById: USER_A,
        field: 'status',
        oldValue: null,
        newValue: String(i),
      });
    }
    const rows = await repos.history.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(rows).toHaveLength(2);
  });
});
