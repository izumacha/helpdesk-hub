// ユーザーリポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: User はパスワードハッシュ・LINE 連携・マジックリンク認証の
// 中核テーブルであり、クロステナント漏洩の影響が最大級にもかかわらず、これまで
// メモリアダプタのテスト (tests/data/user-line-link.memory.test.ts) しか無く、本番 Prisma
// アダプタでの動作 (findById/findByEmail が意図的にテナント横断であること、email の
// @unique 制約、linkLineUserByCode の「条件付き updateMany + (tenantId, lineUserId)
// 一意制約違反時の P2002 捕捉」という非自明な同時実行制御) が未検証だった
// (CLAUDE.md §11「メモリのみのテストは実装の誤った自信を生む」)。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('UserRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A・B を作成する
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'テナントA', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: 'テナントB', mode: 'lite' } });
  });

  // 新規ユーザーを作成できる
  it('新規ユーザーを作成できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const user = await repos.users.create({
      email: 'taro@example.com',
      name: '山田太郎',
      passwordHash: 'hashed',
      role: 'agent',
      tenantId: TENANT_A,
    });
    expect(user.role).toBe('agent');
    expect(user.tenantId).toBe(TENANT_A);
  });

  // email は @unique 制約でテナントを跨いでも重複を拒否する
  it('emailの重複はテナントを跨いでもエラーになる (@unique制約)', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.users.create({
      email: 'dup@example.com',
      name: 'A',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    await expect(
      repos.users.create({
        email: 'dup@example.com',
        name: 'B',
        passwordHash: 'x',
        role: 'requester',
        tenantId: TENANT_B,
      }),
    ).rejects.toThrow();
  });

  // findById/findByEmail は意図的にテナント横断 (認証フローで tenantId 不明のまま引くため)
  it('findByIdとfindByEmailはテナントを問わず取得できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const user = await repos.users.create({
      email: 'cross@example.com',
      name: 'クロス',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_B,
    });
    const byId = await repos.users.findById(user.id);
    const byEmail = await repos.users.findByEmail('cross@example.com');
    expect(byId?.tenantId).toBe(TENANT_B);
    expect(byEmail?.id).toBe(user.id);
  });

  // listAgents/listAgentIds/listAgentEmails は agent+admin のみ、テナントスコープで返す
  it('listAgents系はagent/adminのみをテナントスコープで返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const agentA = await repos.users.create({
      email: 'agent-a@example.com',
      name: 'エージェントA',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT_A,
    });
    await repos.users.create({
      email: 'req-a@example.com',
      name: '依頼者A',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    await repos.users.create({
      email: 'agent-b@example.com',
      name: 'エージェントB',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT_B,
    });
    const agents = await repos.users.listAgents(TENANT_A);
    expect(agents.map((a) => a.id)).toEqual([agentA.id]);
    const agentIds = await repos.users.listAgentIds(TENANT_A);
    expect(agentIds).toEqual([agentA.id]);
    const agentEmails = await repos.users.listAgentEmails(TENANT_A);
    expect(agentEmails).toEqual([{ id: agentA.id, email: 'agent-a@example.com' }]);
  });

  // listAdminEmails は admin のみを返す (agent は含まない)
  it('listAdminEmailsはadminのみを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const admin = await repos.users.create({
      email: 'admin-a@example.com',
      name: '管理者A',
      passwordHash: 'x',
      role: 'admin',
      tenantId: TENANT_A,
    });
    await repos.users.create({
      email: 'agent-a2@example.com',
      name: 'エージェントA2',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT_A,
    });
    const adminEmails = await repos.users.listAdminEmails(TENANT_A);
    expect(adminEmails).toEqual([{ id: admin.id, email: 'admin-a@example.com' }]);
  });

  // countByTenant は agent+admin のみ数え、requester は数えない (シート上限チェック用)
  it('countByTenantはrequesterを除いたスタッフ数を返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.users.create({
      email: 'staff1@example.com',
      name: 'S1',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT_A,
    });
    await repos.users.create({
      email: 'staff2@example.com',
      name: 'S2',
      passwordHash: 'x',
      role: 'admin',
      tenantId: TENANT_A,
    });
    await repos.users.create({
      email: 'member1@example.com',
      name: 'M1',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    expect(await repos.users.countByTenant(TENANT_A)).toBe(2);
  });

  // findSummariesByIds はテナントスコープで絞り込む (他テナントの ID は結果に含まれない)
  it('findSummariesByIdsは他テナントのIDを除外する', async () => {
    const repos = buildPrismaRepos(prisma);
    const userA = await repos.users.create({
      email: 'sum-a@example.com',
      name: 'サマリA',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT_A,
    });
    const userB = await repos.users.create({
      email: 'sum-b@example.com',
      name: 'サマリB',
      passwordHash: 'x',
      role: 'agent',
      tenantId: TENANT_B,
    });
    const result = await repos.users.findSummariesByIds([userA.id, userB.id], TENANT_A);
    expect(result.map((u) => u.id)).toEqual([userA.id]);
  });

  // linkLineUserByCode: 発行コードで連携が成立し、コードが消費される (条件付き updateMany の正常系)
  it('発行コードで連携が成立し、コードが消費される', async () => {
    const repos = buildPrismaRepos(prisma);
    const user = await repos.users.create({
      email: 'line1@example.com',
      name: 'LINE連携1',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await repos.users.setLineLinkCode(user.id, TENANT_A, { codeHash: 'hash-1', expiresAt });

    const result = await repos.users.linkLineUserByCode({
      codeHash: 'hash-1',
      tenantId: TENANT_A,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(result).toEqual({ status: 'linked', userId: user.id });

    const reloaded = await repos.users.findById(user.id);
    expect(reloaded?.lineUserId).toBe('Uline1');
    expect(reloaded?.lineLinkCodeHash).toBeNull();

    // 同じコードでの 2 回目は既に消費済みなので invalid
    const again = await repos.users.linkLineUserByCode({
      codeHash: 'hash-1',
      tenantId: TENANT_A,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(again.status).toBe('invalid');
  });

  // linkLineUserByCode: (tenantId, lineUserId) 一意制約により、別メンバーへの二重連携は conflict
  // になる (事前判定をすり抜けた場合の P2002 捕捉を含む、本番 DB ならではの検証ポイント)
  it('既に連携済みのLINEユーザーIDへの連携はconflictになる', async () => {
    const repos = buildPrismaRepos(prisma);
    const u1 = await repos.users.create({
      email: 'line-u1@example.com',
      name: 'U1',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    const u2 = await repos.users.create({
      email: 'line-u2@example.com',
      name: 'U2',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    // u1 が先に Uline1 と連携済み
    await repos.users.setLineLinkCode(u1.id, TENANT_A, {
      codeHash: 'hash-u1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repos.users.linkLineUserByCode({
      codeHash: 'hash-u1',
      tenantId: TENANT_A,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    // u2 が同じ Uline1 を取りにいくと conflict
    await repos.users.setLineLinkCode(u2.id, TENANT_A, {
      codeHash: 'hash-u2',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await repos.users.linkLineUserByCode({
      codeHash: 'hash-u2',
      tenantId: TENANT_A,
      lineUserId: 'Uline1',
      now: new Date(),
    });
    expect(result.status).toBe('conflict');
    const reloadedU2 = await repos.users.findById(u2.id);
    expect(reloadedU2?.lineUserId).toBeFalsy();
  });

  // findByLineUserId はテナントスコープで引く (別テナントには漏れない)
  it('findByLineUserIdは他テナントには漏れない', async () => {
    const repos = buildPrismaRepos(prisma);
    const user = await repos.users.create({
      email: 'line-scope@example.com',
      name: 'スコープ',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    await repos.users.setLineLinkCode(user.id, TENANT_A, {
      codeHash: 'hash-scope',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repos.users.linkLineUserByCode({
      codeHash: 'hash-scope',
      tenantId: TENANT_A,
      lineUserId: 'UlineScope',
      now: new Date(),
    });
    expect((await repos.users.findByLineUserId(TENANT_A, 'UlineScope'))?.id).toBe(user.id);
    expect(await repos.users.findByLineUserId(TENANT_B, 'UlineScope')).toBeNull();
  });

  // unlinkLineUser は lineUserId と発行中コードをまとめてクリアする
  it('unlinkLineUserで連携を解除できる', async () => {
    const repos = buildPrismaRepos(prisma);
    const user = await repos.users.create({
      email: 'unlink@example.com',
      name: 'アンリンク',
      passwordHash: 'x',
      role: 'requester',
      tenantId: TENANT_A,
    });
    await repos.users.setLineLinkCode(user.id, TENANT_A, {
      codeHash: 'hash-unlink',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repos.users.linkLineUserByCode({
      codeHash: 'hash-unlink',
      tenantId: TENANT_A,
      lineUserId: 'UlineUnlink',
      now: new Date(),
    });
    await repos.users.unlinkLineUser(user.id, TENANT_A);
    const reloaded = await repos.users.findById(user.id);
    expect(reloaded?.lineUserId).toBeNull();
    expect(reloaded?.lineLinkCodeHash).toBeNull();
    expect(reloaded?.lineLinkCodeExpiresAt).toBeNull();
  });
});
