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

  // §4.2.1 フォローアップ再訪 (2026-07-10): before の複合キーセットカーソル (createdAt, id) が
  // 本番 Prisma アダプタの OR クエリ (createdAt < before.createdAt OR (createdAt = ... AND id < ...))
  // として正しく動くことを検証する。createdAt が完全に同一の行があっても、id タイブレーカーにより
  // ページ境界で行を取りこぼさないことが最重要 (tests/data/ticket-history-repository.memory.test.ts
  // と同じ観点をメモリアダプタと同じ規約で本番 DB クエリでも固定する)
  it('createdAtが同一の行はidで安定した順序に並び、beforeカーソルで取りこぼさない', async () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    // Prisma を直接使い、3 行を id 順不同・同一 createdAt で投入する
    // (repos.history.record() は createdAt を DB 既定値 (now()) にしか設定できないため)
    await prisma.ticketHistory.create({
      data: {
        id: 'hst_b',
        ticketId: ticketA,
        changedById: USER_A,
        field: 'status',
        oldValue: 'New',
        newValue: 'Open',
        createdAt: sameInstant,
      },
    });
    await prisma.ticketHistory.create({
      data: {
        id: 'hst_a',
        ticketId: ticketA,
        changedById: USER_A,
        field: 'priority',
        oldValue: 'Low',
        newValue: 'Medium',
        createdAt: sameInstant,
      },
    });
    await prisma.ticketHistory.create({
      data: {
        id: 'hst_c',
        ticketId: ticketA,
        changedById: USER_A,
        field: 'assignee',
        oldValue: null,
        newValue: USER_A,
        createdAt: sameInstant,
      },
    });

    const repos = buildPrismaRepos(prisma);
    // 1 ページ目: id 降順で 2 件だけ取得する (hst_c, hst_b が先頭 2 件になるはず)
    const page1 = await repos.history.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['hst_c', 'hst_b']);

    // 2 ページ目: 1 ページ目の最後の行 (hst_b) をカーソルにすると、残りの hst_a だけが返る
    const page2 = await repos.history.findAllByTenant({
      tenantId: TENANT_A,
      before: { createdAt: sameInstant, kind: 'ticket', id: 'hst_b' },
    });
    expect(page2.map((r) => r.id)).toEqual(['hst_a']);
  });

  // /code-review ultra 再指摘対応: TicketHistory と SettingsAuditLog をまたぐ同時刻の取りこぼしが
  // 無いことを、TicketHistory 側のクエリ分岐 (cursor.kind === 'settings' のとき id を無視して
  // createdAt < before だけで絞る) を実際の DB クエリで検証する
  it('カーソルがsettings由来のとき、同時刻のTicketHistory行は全て除外される', async () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    await prisma.ticketHistory.create({
      data: {
        id: 'hst_after_settings_cursor',
        ticketId: ticketA,
        changedById: USER_A,
        field: 'status',
        oldValue: 'New',
        newValue: 'Open',
        createdAt: sameInstant,
      },
    });

    const repos = buildPrismaRepos(prisma);
    // settings 由来のカーソル (id は TicketHistory の id と無関係な値) を渡す。
    // マージ順序上 'ticket' は 'settings' より先に表示済みのはずなので、id の大小に
    // 関わらず、この createdAt の TicketHistory 行は 1 件も返らないのが正しい
    const page = await repos.history.findAllByTenant({
      tenantId: TENANT_A,
      before: { createdAt: sameInstant, kind: 'settings', id: 'zzz_settings_row' },
    });
    expect(page).toHaveLength(0);
  });
});
