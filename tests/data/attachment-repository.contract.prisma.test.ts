// 添付メタデータ用リポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/attachment-repository.memory.test.ts (メモリアダプタ) しか
// テストが無く、Phase 1 の「スマホ写真添付」機能のテナント境界 (findById/delete の
// tenantId 不一致時の null/no-op) や、Ticket 削除時の ON DELETE CASCADE が実 DB で
// 正しく動くかは未検証だった (CLAUDE.md §11「メモリのみのテストは実装の誤った自信を生む」)。
// クロステナントのファイル漏洩・孤児レコード化を回帰として防ぐことが目的。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';
const USER_B = 'user-b';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('AttachmentRepository (prisma adapter)', () => {
  let prisma: PrismaClient;
  // 各テストで使うチケット ID (テナント A・B にそれぞれ 1 件ずつ作成する)
  let ticketA: string;
  let ticketB: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A/B・ユーザー・チケットを 1 件ずつ用意する
  // (Attachment は ticketId/uploaderId/tenantId の 3 つの FK を必須にするため)
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'テナントA', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: 'テナントB', mode: 'lite' } });
    await prisma.user.create({
      data: {
        id: USER_A,
        email: 'a@example.com',
        name: 'ユーザーA',
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_A,
      },
    });
    await prisma.user.create({
      data: {
        id: USER_B,
        email: 'b@example.com',
        name: 'ユーザーB',
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_B,
      },
    });
    const repos = buildPrismaRepos(prisma);
    const ta = await repos.tickets.create({
      title: 'テナントAのチケット',
      body: '本文',
      priority: 'Medium',
      creatorId: USER_A,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_A,
    });
    ticketA = ta.id;
    const tb = await repos.tickets.create({
      title: 'テナントBのチケット',
      body: '本文',
      priority: 'Medium',
      creatorId: USER_B,
      categoryId: null,
      locationId: null,
      tenantId: TENANT_B,
    });
    ticketB = tb.id;
  });

  // 添付を 1 件作成でき、同一テナントで findById できる
  it('createしたものと同一テナントでfindByIdできる', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 1024,
      originalName: 'photo.jpg',
      storageKey: `${TENANT_A}/${ticketA}/aaaa.jpg`,
      storage: 'local',
    });
    const found = await repos.attachments.findById(created.id, TENANT_A);
    expect(found?.originalName).toBe('photo.jpg');
  });

  // 他テナントの ID で findById すると null (クロステナント漏洩防止の要)
  it('他テナントIDでfindByIdするとnullになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 1024,
      originalName: 'photo.jpg',
      storageKey: `${TENANT_A}/${ticketA}/aaaa.jpg`,
      storage: 'local',
    });
    const found = await repos.attachments.findById(created.id, TENANT_B);
    expect(found).toBeNull();
  });

  // listByTicket は同一テナントの行のみを古い順に返す
  it('listByTicketは同一テナントの行のみ古い順に返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const a1 = await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 100,
      originalName: 'a1.jpg',
      storageKey: `${TENANT_A}/${ticketA}/a1.jpg`,
      storage: 'local',
    });
    const a2 = await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 100,
      originalName: 'a2.jpg',
      storageKey: `${TENANT_A}/${ticketA}/a2.jpg`,
      storage: 'local',
    });
    const list = await repos.attachments.listByTicket(ticketA, TENANT_A);
    expect(list.map((x) => x.id)).toEqual([a1.id, a2.id]);
  });

  // sumSizeByTenant は同一テナントの添付サイズのみを DB 側で集計する (aggregate SUM)
  it('sumSizeByTenantは同一テナントの合計バイト数を返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 1000,
      originalName: 'a1.jpg',
      storageKey: `${TENANT_A}/${ticketA}/a1.jpg`,
      storage: 'local',
    });
    await repos.attachments.create({
      ticketId: ticketB,
      commentId: null,
      uploaderId: USER_B,
      tenantId: TENANT_B,
      mimeType: 'image/jpeg',
      size: 500,
      originalName: 'b1.jpg',
      storageKey: `${TENANT_B}/${ticketB}/b1.jpg`,
      storage: 'local',
    });
    expect(await repos.attachments.sumSizeByTenant(TENANT_A)).toBe(1000);
    expect(await repos.attachments.sumSizeByTenant(TENANT_B)).toBe(500);
  });

  // 添付が無いテナントは 0 を返す (aggregate の _sum が null になるケースの防御)
  it('添付が無いテナントのsumSizeByTenantは0になる', async () => {
    const repos = buildPrismaRepos(prisma);
    expect(await repos.attachments.sumSizeByTenant(TENANT_A)).toBe(0);
  });

  // 他テナントの ID を渡した削除は no-op (元行が残る)
  it('他テナントIDでのdeleteはno-opになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 100,
      originalName: 'a1.jpg',
      storageKey: `${TENANT_A}/${ticketA}/a1.jpg`,
      storage: 'local',
    });
    await repos.attachments.delete(created.id, TENANT_B);
    expect(await repos.attachments.findById(created.id, TENANT_A)).not.toBeNull();
    await repos.attachments.delete(created.id, TENANT_A);
    expect(await repos.attachments.findById(created.id, TENANT_A)).toBeNull();
  });

  // 親チケットを削除すると添付メタデータも連鎖削除される (ON DELETE CASCADE の実 DB 検証)
  it('親チケット削除で添付メタデータも連鎖削除される', async () => {
    const repos = buildPrismaRepos(prisma);
    const created = await repos.attachments.create({
      ticketId: ticketA,
      commentId: null,
      uploaderId: USER_A,
      tenantId: TENANT_A,
      mimeType: 'image/jpeg',
      size: 100,
      originalName: 'a1.jpg',
      storageKey: `${TENANT_A}/${ticketA}/a1.jpg`,
      storage: 'local',
    });
    // チケットを直接 Prisma で削除する (Ticket の ON DELETE CASCADE を検証したいので repos 経由ではなく直叩き)
    await prisma.ticket.delete({ where: { id: ticketA } });
    expect(await repos.attachments.findById(created.id, TENANT_A)).toBeNull();
  });
});
