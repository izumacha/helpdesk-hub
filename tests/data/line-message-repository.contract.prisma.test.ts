// LINE メッセージ対応表リポジトリ (本番 Prisma 実装) の契約テスト。
// メッセージ ID → チケットの逆引き・冪等登録・クロステナント分離 (§9) を実 DB で検証する。
// RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを TRUNCATE するため
// **開発 DB を指さないこと** (CLAUDE.md §テスト)。専用 DB で実行する。

// Vitest の DSL とフック
import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
// Prisma クライアント本体 (生成物)
import { PrismaClient } from '@/generated/prisma';
// 本番 Prisma 実装の repos 束を組み立てる関数
import { buildPrismaRepos } from '@/data/adapters/prisma';

// テナント A / B の ID
const TENANT_A = 'default-tenant';
const TENANT_B = 'tenant-b';

// DB 依存テストを実行してよいかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('LineMessageRef prisma adapter', () => {
  // スイート全体で共有する PrismaClient
  let prisma: PrismaClient;

  // スイート開始時に 1 度だけ接続する
  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  // スイート終了時に接続を閉じる (接続リーク防止)
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にし、テナント A/B とそれぞれのチケットをシードする。
  // LineMessageRef は Tenant/Ticket への CASCADE FK があるため、Tenant TRUNCATE で連鎖的に消える。
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "LineMessageRef","EmailThreadRef","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","Invitation","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
    // テナント A / B を作成する
    await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
    await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
    // 各テナントに 1 人ユーザーと 1 件チケットを用意する (LineMessageRef の FK 先)
    for (const [tenantId, suffix] of [
      [TENANT_A, 'a'],
      [TENANT_B, 'b'],
    ] as const) {
      await prisma.user.create({
        data: {
          id: `u-${suffix}`,
          email: `user-${suffix}@example.com`,
          name: `ユーザー${suffix}`,
          passwordHash: 'x',
          role: 'requester',
          tenantId,
        },
      });
      await prisma.ticket.create({
        data: {
          id: `t-${suffix}`,
          title: '件名',
          body: '本文',
          creatorId: `u-${suffix}`,
          tenantId,
        },
      });
    }
  });

  // 登録したメッセージ ID から ticketId を逆引きできる
  it('登録したメッセージ ID からチケットを逆引きできる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't-a', tenantId: TENANT_A });
    expect(await repos.lineMessages.findTicketIdByMessageId('m1', TENANT_A)).toBe('t-a');
  });

  // 同一 (tenant, lineMessageId) の二重登録は冪等 (createMany skipDuplicates)
  it('同一メッセージ ID の二重登録は冪等', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't-a', tenantId: TENANT_A });
    // 2 回目も例外を投げず、件数は 1 のまま
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't-a', tenantId: TENANT_A });
    expect(await prisma.lineMessageRef.count()).toBe(1);
  });

  // 別テナントのメッセージ ID は突き合わせ対象にしない (クロステナント遮断)
  it('別テナントのメッセージ ID は逆引きできない', async () => {
    const repos = buildPrismaRepos(prisma);
    // テナント B に登録したメッセージ ID は…
    await repos.lineMessages.register({ lineMessageId: 'm1', ticketId: 't-b', tenantId: TENANT_B });
    // テナント A のスコープでは見つからない
    expect(await repos.lineMessages.findTicketIdByMessageId('m1', TENANT_A)).toBeNull();
    // 自テナント (B) では引ける
    expect(await repos.lineMessages.findTicketIdByMessageId('m1', TENANT_B)).toBe('t-b');
  });

  // 別テナントが同じメッセージ ID を使っても衝突しない ((tenantId, lineMessageId) 複合一意のため)
  it('テナントが違えば同一メッセージ ID を別々に登録できる', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.lineMessages.register({ lineMessageId: 'same', ticketId: 't-a', tenantId: TENANT_A });
    await repos.lineMessages.register({ lineMessageId: 'same', ticketId: 't-b', tenantId: TENANT_B });
    expect(await prisma.lineMessageRef.count()).toBe(2);
  });
});
